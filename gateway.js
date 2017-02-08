var Hapi = require('hapi');
var irc = require('irc');
var request = require('request');
var async = require('async');
var Entities = require('html-entities').AllHtmlEntities;
var entities = new Entities();
var emoji = require('./emoji');
var queue = require('./queue').queue;

var config   = require(__dirname + '/config.json');

var clients = {}
var queued = {}
var timers = {}

var server = new Hapi.Server();
server.connection({
  host: config.host,
  port: config.port
});

server.route({
  method: 'GET',
  path: '/',
  handler: function (request, reply) {
    reply('Hello world');
  }
});

server.route({
  method: 'POST',
  path: '/gateway/input',
  handler: function (request, reply) {
    var channel = request.payload.channel_name;
    var username = request.payload.user_name.replace(".","_");
    var text = request.payload.text;

    reply('ok: '+username);
    
    // Map Slack channels to IRC channels, and ignore messages from channels that don't have a mapping
    var irc_channel = false;
    for(var i in config.channels) {
      if(channel == config.channels[i].slack) {
        irc_channel = config.channels[i].irc;
      }
    }

    // Don't echo things that slackbot says in Slack on behalf of IRC users.
    // Unfortunately there's nothing in the webhook payload that distinguishes
    // the messages from IRC users and those from other things SlackBot does.    
    if(username != 'slackbot' && irc_channel) {
      // Replace Slack refs with IRC refs
      replace_slack_entities(text, function(text) {
        console.log("INPUT: #"+channel+" ["+username+"] "+text);
        process_message(irc_channel, username, 'slack', text);
      });
    }
  }
});

server.route({
  method: 'POST',
  path: '/web/input',
  handler: function (request, reply) {
    var username = request.payload.user_name;
    var text = request.payload.text;
    var channel = request.payload.channel;

    reply('ok: '+username);
    
    process_message(channel, username, 'web', text);
  }
});

// The web IRC gateway will post to here after the user enters their nick
server.route({
  method: 'POST',
  path: '/web/join',
  handler: function (request, reply) {
    var username = request.payload.user_name;
    
    if(clients["web:"+username] == null) {
      connect_to_irc(username, username, 'web');
      reply('connecting');
    } else {
      reply('connected');
    }
  }
});

server.start(function () {
  console.log('Server running at:', server.info.uri);
});

function slack_api(method, params, callback) {
  params['token'] = config.slack.token;
  request.post("https://slack.com/api/"+method, {
    form: params
  }, function(err,response,body){
    var data = JSON.parse(body);
    callback(err, data);
  });
}

function replace_slack_entities(text, replace_callback) {
  text = text.replace(new RegExp('<([a-z]+:[^\\|>]+)\\|([^>]+)>','g'), '$2');
  text = text.replace(new RegExp('<([a-z]+:[^\\|>]+)>','g'), '$1');
  
  text = emoji.slack_to_unicode(text);

  if(matches=text.match(/<[@#]([UC][^>\|]+)(?:\|([^\|]+))?>/g)) {
    async.map(matches, function(entity, callback){
      var match = entity.match(/<([@#])([UC][^>\|]+)(?:\|([^\|]+))?>/);
      //console.log("Processing "+match[2]);
      if(match[1] == "@"){
        slack_api("users.info", {user: match[2]}, function(err, data){
          //console.log(entity+" => "+data.user.name);
          callback(err, {match: entity, replace: data.user.name});
        });
      } else {
        slack_api("channels.info", {channel: match[2]}, function(err, data){
          //console.log(entity+" => "+data.channel.name);
          callback(err, {match: entity, replace: "#"+data.channel.name});
        });
      }
    }, function(err, results) {
      //console.log(results);
      for(var i in results) {
        text = text.replace(results[i].match, results[i].replace);
      }
      replace_callback(entities.decode(text));
    });
  } else {
    replace_callback(entities.decode(text));
  }
}


function process_message(channel, username, method, text) {
  var irc_nick;
  if(method == 'slack') {
    irc_nick = "["+username.replace(".","_")+"]";
  } else {
    irc_nick = username;
  }

  // Connect and add to the queue
  if(clients[method+":"+username] == null) {
    if(queued[method+":"+username] == null) {
      queued[method+":"+username] = new queue();
    }
    queued[method+":"+username].push(channel, text);

    connect_to_irc(username, irc_nick, method);
  } else if(queued[method+":"+username] && queued[method+":"+username].length() > 0) {
    // There is already a client and something in the queue, which means
    // the bot is currently connecting. Keep adding to the queue
    queued[method+":"+username].push(channel, text);
  } else {
    // Queue is empty, so bot is already connected
    var match;
    if(match=text.match(/^\/nick (.+)/)) {
      clients[method+":"+username].send("NICK", match[1]);
    } else {
      clients[method+":"+username].say(channel, text);
    }

    clearTimeout(timers[method+":"+username]);
    timers[method+":"+username] = setTimeout(function(){
      console.log("Timed out: "+username)
      clients[method+":"+username].disconnect('went away');
      clients[method+":"+username] = null;
      timers[method+":"+username] = null;
    }, config.irc.disconnect_timeout);
  }
}

function connect_to_irc(username, irc_nick, method) {
  clients[method+":"+username] = new irc.Client(config.irc.hostname, irc_nick, {
    autoConnect: false,
    debug: true,
    userName: method+'user',
    realName: username+" via "+method+"-irc-gateway",
    channels: config.channels.map(function(c){ return c.irc; })
  });

  clients[method+":"+username].connect(function() {
    console.log("Connecting to IRC... Channels: "+[config.channels.map(function(c){ return c.irc; })].join());
  });

  clients[method+":"+username].addListener('join', function(channel, nick, message){
    console.log("[join] "+nick+" joined "+channel+" (me: "+clients[method+":"+username].nick+")");
    if(nick == clients[method+":"+username].nick) {
      console.log(irc_nick+ " successfully joined "+channel+"! (joined as "+nick+")");

      // Now send the queued messages for the channel
      if(queued[method+":"+username]) {
        var text;
        while(text = queued[method+":"+username].pop(channel)) {
          clients[method+":"+username].say(channel, text);
        }
      }
        
      // Set a timer to disconnect the bot after a while
      timers[method+":"+username] = setTimeout(function(){
        clients[method+":"+username].disconnect('Slack user timed out');
        clients[method+":"+username] = null;
        timers[method+":"+username] = null;
      }, config.irc.disconnect_timeout);
    }
  });
}
