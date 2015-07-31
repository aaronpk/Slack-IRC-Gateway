var Hapi = require('hapi');
var irc = require('irc');
var request = require('request');
var async = require('async');
var Entities = require('html-entities').AllHtmlEntities;
var entities = new Entities();

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
    var username = request.payload.user_name;
    var text = request.payload.text;

    reply('ok: '+username);

    // Replace Slack refs with IRC refs
    replace_slack_entities(text, function(text) {
      console.log("Replaced: "+text);
      process_message(username, text);
    });
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


function process_message(username, text) {
  var irc_nick = "["+username+"]";

  // No client, and nothing in the queue
  // Connect and add to the queue
  if(clients[username] == null && queued[username] == null) {
    if(queued[username] == null) {
      queued[username] = [];
    }
    queued[username].push(text);

    clients[username] = new irc.Client(config.irc.hostname, irc_nick, {
      autoConnect: false,
      debug: true,
      userName: username,
      realName: username,
      channels: [config.irc.channel]
    });

    clients[username].connect(function() {
      console.log("Connecting to IRC...");
    });

    clients[username].addListener('join', function(channel, nick, message){
      console.log("[join] "+nick+" joined "+channel);
      if(irc_nick == nick) {
        console.log("Registered!");
        // Now send the queued messages
        for(var i in queued[username]) {
          clients[username].say(config.channel, queued[username][i]);
        }
        queued[username] = null;

        // Set a timer to disconnect the bot after a while
        timers[username] = setTimeout(function(){
          clients[username].disconnect('Slack user timed out');
          clients[username] = null;
          timers[username] = null;
        }, config.irc.disconnect_timeout);
      }
    });
  } else if(queued[username] && queued[username].length > 0) {
    // There is already a client and something in the queue, which means
    // the bot is currently connecting. Keep adding to the queue
    queued[username].push(text);
  } else {
    // Bot is already connected
    clients[username].say(config.channel, text);

    clearTimeout(timers[username]);
    timers[username] = setTimeout(function(){
      console.log("Timed out: "+username)
      clients[username].disconnect('went away');
      clients[username] = null;
      timers[username] = null;
    }, config.irc.disconnect_timeout);
  }
}

