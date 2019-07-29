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
var sessions = {}
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
    reply('This is a Slack/IRC Gateway. Source code here: https://github.com/aaronpk/Slack-IRC-Gateway');
  }
});

server.route({
  method: 'POST',
  path: '/gateway/input',
  handler: function (req, reply) {

    // Don't echo things that slackbot says in Slack on behalf of IRC users.
    // TODO: Investigate whether req.payload.bot_id can be used to filter these instead.
    // Right now this ignores everything Slackbot does, even stuff it does on its own.
    if(req.payload.user_id == 'USLACKBOT') {
      return;
    }
  
    var channel = req.payload.channel_name;
    var text = req.payload.text;
    
    // Map Slack channels to IRC channels, and ignore messages from channels that don't have a mapping
    var irc_channel = false;
    var expected_token = false;
    for(var i in config.channels) {
      if(channel == config.channels[i].slack) {
        irc_channel = config.channels[i].irc;
        expected_token = config.channels[i].slack_token;
      }
    }

    // Verify the request came from Slack
    if(!expected_token || req.payload.token != expected_token) {
      reply('unauthorized');
      return;
    }

    // Acknowledge the Slack webhook immediately
    reply('ok: '+req.payload.user_name);

    if(irc_channel) {
      slack_user_id_to_username(req.payload.user_id, function(err, username){
        if(err) {
          console.log("Error looking up user ID: "+req.payload.user_id);
        } else {
          // If there are any files in the image, make them public and process this as an image instead
          if(match=text.match(/uploaded a file:.+files\/[^\/]+\/(F[^\/]+)/)) {
            slack_api("files.sharedPublicURL", {
              file: match[1]
            }, function(err,data){
              // The only "public" aspect that Slack returns is a web page that embeds the image.
              // Parse the web page looking for the img tag that contains the actual image URL.
              request.get(data.file.permalink_public, function(err, response, body) {
                // http://xkcd.com/208/
                if(imgmatch=body.match(/img src="([^"]+pub_secret=[^"]+)"/)) {
                  var file_url = imgmatch[1] + "&name=" + data.file.name;
                  console.log("Found public file URL: "+file_url);

                  // If the user enters a title for the image that's different from the filename,
                  // include that in the message sent to IRC.
                  if(data.file.title != data.file.name) {
                    text = data.file.title + " " + file_url;
                  } else {
                    text = file_url;
                  }

                  // If the file has a comment, include that after the image.
                  // (may contain slack entities that need replacing)
                  if(data.file.initial_comment) {
                    text += " " + data.file.initial_comment.comment;
                    replace_slack_entities(text, function(text) {
                      console.log("INPUT (file with comment): #"+channel+" ["+username+"] "+text);
                      process_message(irc_channel, username, 'slack', text);
                    });
                  } else {
                    console.log("INPUT (file with no comment): #"+channel+" ["+username+"] "+text);
                    process_message(irc_channel, username, 'slack', text);
                  }

                } else {
                  console.log("[error] Could not find image URL in the public file web page");
                }
              });
            });
          } else {
            // Replace Slack refs with IRC refs
            replace_slack_entities(text, function(text) {
              console.log("INPUT: #"+channel+" ["+username+"] "+text);
              process_message(irc_channel, username, 'slack', text);
            });
          }
        }
      });
    } else {
      // No IRC channel configured for this Slack channel
    }
  }
});

server.route({
  method: 'POST',
  path: '/web/input',
  handler: function (request, reply) {
    if(request.payload.token != config.web.token) {
      reply('unauthorized');
    } else {
      if(sessions[request.payload.session]) {
        var session = sessions[request.payload.session];

        var username = session.username;
        var text = request.payload.text;
        var channel = request.payload.channel;

        reply({username: username});
        
        process_message(channel, username, 'web', text);
      } else {
        reply({error: 'invalid_session'})
      }
    }
  }
});

// The web IRC gateway will post to here after the user enters their nick
server.route({
  method: 'POST',
  path: '/web/join',
  handler: function (request, reply) {
    if(request.payload.token != config.web.token) {
      reply('unauthorized');
    } else {
      var username = request.payload.user_name;
      
      if(clients["web:"+username] == null) {
        connect_to_irc(username, username, 'web');
        // Reply with a session token that will be required with every message to /web/input
        reply({"status": "connecting", "session": clients["web:"+username].websession});
      } else {
        reply({"status":"connected", "session": clients["web:"+username].websession});
      }
    }
  }
});

server.route({
  method: 'POST',
  path: '/web/session',
  handler: function (request, reply) {
    if(request.payload.token != config.web.token) {
      reply('unauthorized');
    } else {
      if(sessions[request.payload.session]) {
        var data = sessions[request.payload.session];
        reply({username: data.username});
      } else {
        reply({});
      }
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

var username_cache = {};

function slack_user_id_to_username(uid, callback) {
  if(username_cache[uid]) {
    callback(null, username_cache[uid]);
  } else {
    slack_api("users.info", {user: uid}, function(err, data){
      var name;
      if(data.user.profile.display_name_normalized) {
        name = data.user.profile.display_name_normalized;
      } else {
        name = data.user.name; // fallback for users who haven't set a display name
      }
      var username = name.replace(/[^a-zA-Z0-9_]/, '_');
      console.log("Username: "+uid+" => "+username);
      username_cache[uid] = username;
      callback(err, username);
    });
  }
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
        slack_user_id_to_username(match[2], function(err, username){
          callback(err, {match: entity, replace: "["+username+"]"});
        });
      } else {
        slack_api("channels.info", {channel: match[2]}, function(err, data){
          // If this channel matches one in the config, convert to the IRC name
          var irc_channel = irc_channel_from_slack_channel(data.channel.name);
          callback(err, {match: entity, replace: irc_channel});
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

function irc_channel_from_slack_channel(name) {
  var irc_channel = '#'+name;
  for(var i in config.channels) {
    if(name == config.channels[i].slack) {
      irc_channel = config.channels[i].irc;
    }
  }
  return irc_channel;
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
    } else if(match=text.match(/^\/me (.+)/)) {
      clients[method+":"+username].action(channel, match[1]);
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
    debug: false,
    userName: method+'user',
    realName: username+" via "+method+"-irc-gateway",
    channels: config.channels.map(function(c){ return c.irc; })
  });

  clients[method+":"+username].websession = Math.random().toString(36);
  sessions[clients[method+":"+username].websession] = {method: method, username: username};

  // Set a timer to disconnect the bot after a while
  timers[method+":"+username] = setTimeout(function(){
    console.log("[timeout] ("+method+"/"+username+") timed out");
    if(clients[method+":"+username]) {
      clients[method+":"+username].disconnect('Slack user timed out');
    }
    clients[method+":"+username] = null;
    timers[method+":"+username] = null;
  }, config.irc.disconnect_timeout);

  clients[method+":"+username].connect(function() {
    console.log("[connecting] ("+method+"/"+username+") Connecting to IRC... Channels: "+[config.channels.map(function(c){ return c.irc; })].join());
  });

  clients[method+":"+username].addListener('join', function(channel, nick, message){
    console.log("[join] "+nick+" joined "+channel+" (me: "+clients[method+":"+username].nick+")");
    if(nick == clients[method+":"+username].nick) {
      console.log("[debug] "+irc_nick+" successfully joined "+channel+"! (joined as "+nick+")");

      // Now send the queued messages for the channel
      if(queued[method+":"+username]) {
        // Delay to give Loqi time to +v
        (function(method, username, channel){
          setTimeout(function(){
            var text;
            while(text = queued[method+":"+username].pop(channel)) {
              clients[method+":"+username].say(channel, text);
            }
          }, 500);
        })(method, username, channel);
      }
    }
  });

  clients[method+":"+username].addListener('error', function(message) {
    console.log("[error] ("+method+"/"+username+") ", message);
  });

  clients[method+":"+username].addListener('pm', function(from, message) {
    clients[method+":"+username].say(from, "[error] Sorry, private messages to users of the "+method+" gateway are not supported.");
  })
}
