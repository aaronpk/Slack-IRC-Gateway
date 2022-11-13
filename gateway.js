const Hapi = require('@hapi/hapi');
var irc = require('irc');
var request = require('request');
var async = require('async');
const {decode} = require('html-entities');
var emoji = require('./emoji');
var queue = require('./queue').queue;

// Provide a mechanism to allow project-specific text replacements
const fs = require('fs');
var replacements;
try {
  if(fs.existsSync("./replacements.js")) {
    replacements = require("./replacements");
  }
} catch(err) {
}


var config   = require(__dirname + '/config.json');

var clients = {}
var sessions = {}
var queued = {}
var timers = {}

var ircToSlack;
var ircUsers = [];

var server = new Hapi.Server({
  host: config.host,
  port: config.port
});

server.route({
  method: 'GET',
  path: '/',
  handler: function (request, h) {
    return 'This is a Slack/IRC Gateway. Source code here: https://github.com/aaronpk/Slack-IRC-Gateway';
  }
});

server.route({
  method: 'POST',
  path: '/gateway/input',
  handler: function (req, h) {

    // Respond to the Slack Events API challenge
    if(req.payload.type == "url_verification") {
      console.log("Event API Token: "+req.payload.token);
      return {challenge: req.payload.challenge};
    }

    if(!req.payload.event) {
      return;
    }

    // Ignore everything except regular text messages and "/me"
    if(!(req.payload.event.subtype == null || req.payload.event.subtype == "me_message")) {
      return 'ignoring';
    }

    // Verify the request came from Slack
    if(config.slack.event_api_token != req.payload.token) {
      return 'unauthorized';
    }

    var event = req.payload.event;

    // console.log(event);

    // Map Slack channels to IRC channels, and ignore messages from channels that don't have a mapping
    var irc_channel = false;
    for(var i in config.channels) {
      if(event.channel == config.channels[i].slack_id) {
        irc_channel = config.channels[i].irc;
      }
    }

    if(!irc_channel) {
      return 'no irc channel';
    }

    // Acknowledge the Slack webhook immediately
    // reply('ok: '+event.client_msg_id);

    slack_user_id_to_username(event.user, function(err, username){
      if(err) {
        console.log("Error looking up user ID: "+event.user);
      } else {

        switch(event.type) {
          case "message":
            if(event.text) {
              // Replace Slack refs with IRC refs
              replace_slack_entities(event.text, function(text) {
                console.log("INPUT: #"+irc_channel+" "+event.channel+" ["+username+"] "+text);
                if(event.subtype == "me_message") {
                  text = "/me "+text;
                }
                if(event.thread_ts) {
                  text = "↩️ "+text;
                }
                process_message(irc_channel, username, 'slack', text);
              });
            }

            // If there are any files in the image, make them public and send the image URL too
            if(event.files) {
              for(var i in event.files) {
                var file = event.files[i];
                slack_api("files.sharedPublicURL", {
                  file: file.id
                }, function(err, data){
                  if(!err) {
                    var file_url = data.file.permalink_public;
                    console.log("File made public: "+file_url);
                    // The only "public" aspect that Slack returns is a web page that embeds the image.
                    // Parse the web page looking for the img tag that contains the actual image URL.
                    request.get(data.file.permalink_public, function(err, response, body) {
                      if(imgmatch=body.match(/img src="([^"]+pub_secret=[^"]+)"/)) {
                        var file_url = imgmatch[1];
                        process_message(irc_channel, username, 'slack', file_url);
                      }
                    });

                  }

                });
              }
            }
            break;
        }
      }
    });

    return 'ok: '+event.client_msg_id;
  }
});

server.route({
  method: 'POST',
  path: '/web/input',
  handler: function (request, h) {
    if(request.payload.token != config.web.token) {
      return 'unauthorized';
    } else {
      if(sessions[request.payload.session]) {
        var session = sessions[request.payload.session];

        var username = session.username;
        var text = request.payload.text;
        var channel = request.payload.channel;

        return {username: username};

        process_message(channel, username, 'web', text);
      } else {
        return {error: 'invalid_session'};
      }
    }
  }
});

// The web IRC gateway will post to here after the user enters their nick
server.route({
  method: 'POST',
  path: '/web/join',
  handler: function (request, h) {
    if(request.payload.token != config.web.token) {
      return 'unauthorized';
    } else {
      var username = request.payload.user_name;

      if(clients["web:"+username] == null) {
        connect_to_irc(username, username, 'web');
        // Reply with a session token that will be required with every message to /web/input
        return {"status": "connecting", "session": clients["web:"+username].websession};
      } else {
        return {"status":"connected", "session": clients["web:"+username].websession};
      }
    }
  }
});

server.route({
  method: 'POST',
  path: '/web/session',
  handler: function (request, h) {
    if(!request.payload || request.payload.token != config.web.token) {
      return 'unauthorized';
    } else {
      if(sessions[request.payload.session]) {
        var data = sessions[request.payload.session];
        return {username: data.username};
      } else {
        return {};
      }
    }
  }
});

server.start(function () {
  console.log('Server running at:', server.info.uri);
});

var ircToSlackQueue = [];

// Create an IRC bot that joins all the channels to route messages to Slack
var options = {
  autoConnect: false,
  debug: true,
  userName: config.irc.gateway_nick,
  realName: "IRC to Slack Gateway",
  channels: config.channels.map(function(c){ return c.irc; }),
  ...config.irc.options
};
ircToSlack = new irc.Client(config.irc.hostname, config.irc.gateway_nick, options);
ircToSlack.connect(function(){
  console.log("[connecting] Connecting Gateway user to IRC... Channels: "+[config.channels.map(function(c){ return c.irc; })].join());
});
ircToSlack.addListener('join', function(channel, nick, message){
  console.log('[join] Successfully joined '+channel);
});
ircToSlack.addListener('ctcp-privmsg', function(nick, channel, message, event){
  process_irc_to_slack(nick, channel, message.replace(/[\x00-\x1F\x7F-\x9F]/g,'').replace(/^ACTION /,''), 'message', event);
});
ircToSlack.addListener('message', function(nick, channel, message, event) {
  process_irc_to_slack(nick, channel, message, 'ctcp', event);
});

var slack_queue = [];
function send_to_slack_from_queue() {
  var payload = slack_queue.shift();
  if(payload) {
    request.post(config.slack.hook, {
      form: {
        payload: JSON.stringify(payload)
      }
    }, function(err,response,body){
      setTimeout(send_to_slack_from_queue, 1000);
    });
  } else {
    setTimeout(send_to_slack_from_queue, 1000);
  }
}
send_to_slack_from_queue();

function process_irc_to_slack(nick, channel, message, type, event) {
  console.log('[irc] ('+channel+' '+nick+' '+type+') "'+message+'"');

  // Ignore IRC messages from this Slack gateway
  if(event.user == '~slackuser') {
    return;
  }

  // Convert IRC text to Slack text

  // Strip IRC control chars
  message = message.replace(/\x03\d{1,2}/g, '').replace(/\x03/, '');

  // Convert mentions of slack usernames "[aaronpk]" to native slack IDs if we know them
  message = message.replace(/\[([a-zA-Z0-9_-]+)\]/g, function(matched, nickname, index){
    var slack_user_id = slack_username_to_id(nickname);
    if(slack_user_id) {
      return '<@'+slack_user_id+'>';
    } else {
      return matched;
    }
  });

  // Convert mentions of channel names to the slack equivalents <#C000XX0XX>
  for(var i in config.channels) {
    var rxp = new RegExp('([^a-z\-]|^)'+config.channels[i].irc+'([^a-z\-]|$)', "g");
    message = message.replace(rxp, "$1<#"+config.channels[i].slack_id+">$2")
  }

  if(replacements) {
    message = replacements.irc_to_slack(message, channel);
  }

  // Route the message to the appropriate Slack channel
  // Slack API rate limits 1/sec, so add these to a queue which is processed separately
  var ch = slack_channel_from_irc_channel(channel);
  if(ch) {
    var icon_url = false;
    var profile;

    if(profile=profile_for_irc_nick(nick)) {
      if(profile.photo) {
        icon_url = profile.photo[0];
      }
    }

    slack_queue.push({
      text: message,
      username: nick,
      channel: ch,
      icon_url: icon_url
    });
  }

}
ircToSlack.addListener('pm', function(from, message){
  ircToSlack.say(from, "The source code of this bot is available here: https://github.com/aaronpk/slack-irc-gateway");
});


// Load IRC users from file to variable every 5 minutes
function reload_irc_users_from_file() {
  if(fs.existsSync("./data/irc-users.json")) {
    try {
      tmpircUsers = JSON.parse(fs.readFileSync('./data/irc-users.json'));
      ircUsers = tmpircUsers;
    } catch(e) {
      console.log("ERROR LOADING USERS FROM FILE");
    }
  }
}
reload_irc_users_from_file();
setInterval(reload_irc_users_from_file, 60*5);

function profile_for_irc_nick(nick) {
  for(var i in ircUsers) {
    if(nick == ircUsers[i].properties.nickname) {
      return ircUsers[i].properties;
    }
  }
  return null;
}



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
var userid_cache = {};

function slack_user_id_to_username(uid, callback) {
  if(username_cache[uid]) {
    callback(null, username_cache[uid]);
  } else {
    slack_api("users.info", {user: uid}, function(err, data){
      if(err) {
        console.error("Error getting user info", err);
      } else {
        if(!data.user) {
          console.error("No user data found", data);
          return;
        }
        var name;
        if(data.user.profile.display_name_normalized) {
          name = data.user.profile.display_name_normalized;
        } else {
          name = data.user.name; // fallback for users who haven't set a display name
        }
        // Turn a Slack name into IRC-safe chars.
        // Use only alphanumeric and underscore,
        // collapse multiple underscores,
        // cap at 14 chars (IRC limit is 16, we add [] later)
        var username = name.replace(/[^a-zA-Z0-9_]/g, '_').replace(/_+/, '_').substring(0,14);
        console.log("Username: "+uid+" => "+username);
        username_cache[uid] = username;
        userid_cache[username.toLowerCase()] = uid;
        callback(err, username);
      }
    });
  }
}

function slack_username_to_id(username) {
  if(userid_cache[username.toLowerCase()]) {
    return userid_cache[username.toLowerCase()];
  } else {
    return false;
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
        // If this channel matches one in the config, convert to the IRC name
        var irc_channel = irc_channel_from_slack_channel_id(match[2]);
        if(irc_channel) {
          callback(null, {match: entity, replace: irc_channel});
        } else {
          slack_api("channels.info", {channel: match[2]}, function(err, data){
            var irc_channel = irc_channel_from_slack_channel(data.channel.name);
            callback(err, {match: entity, replace: irc_channel});
          });
        }
      }
    }, function(err, results) {
      //console.log(results);
      for(var i in results) {
        text = text.replace(results[i].match, results[i].replace);
      }
      replace_callback(decode(text));
    });
  } else {
    replace_callback(decode(text));
  }
}

function irc_channel_from_slack_channel(name) {
  var irc_channel = '#'+name;
  for(var i in config.channels) {
    if(name == config.channels[i].slack_name) {
      irc_channel = config.channels[i].irc;
    }
  }
  return irc_channel;
}

function irc_channel_from_slack_channel_id(channel_id) {
  var irc_channel = null;
  for(var i in config.channels) {
    if(channel_id == config.channels[i].slack_id) {
      irc_channel = config.channels[i].irc;
    }
  }
  return irc_channel;
}

function slack_channel_from_irc_channel(name) {
  var slack_channel = false;
  for(var i in config.channels) {
    if(name == config.channels[i].irc) {
      slack_channel = '#'+config.channels[i].slack_name;
    }
  }
  return slack_channel;
}

function process_message(channel, username, method, text) {
  var irc_nick;
  if(method == 'slack') {
    irc_nick = "["+username+"]";
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
    } else if(match=text.match(/^\/quit/)) {
      clients[method+":"+username].disconnect('quit');
    } else {
      clients[method+":"+username].say(channel, text);
    }

    keepalive(method, username);
  }
}

function keepalive(method, username) {
  var timeout;
  
  if(method == 'slack') {
    timeout = config.slack.disconnect_timeout;
  } else {
    timeout = config.web.disconnect_timeout;    
  }
  
  clearTimeout(timers[method+":"+username]);
  timers[method+":"+username] = setTimeout(function(){
    console.log(method+" user timed out: "+username);
    if(clients[method+":"+username]) {
      clients[method+":"+username].disconnect('went away');
    }
    clients[method+":"+username] = null;
    timers[method+":"+username] = null;
  }, timeout);
}

function connect_to_irc(username, irc_nick, method) {
  const clientId = method + ":" + username;
  const ircClient = new irc.Client(config.irc.hostname, irc_nick, {
    autoConnect: false,
    debug: false,
    userName: method+'user',
    realName: username+" via "+method+"-irc-gateway",
    channels: config.channels.map(function(c){ return c.irc; })
  });
  clients[clientId] = ircClient;

  ircClient.websession = Math.random().toString(36);
  sessions[ircClient.websession] = {method: method, username: username};

  // Set a timer to disconnect the bot after a while
  keepalive(method, username);

  const nickReclaimListener = (nick, reason, channels, quitMessage) => {
    if (nick != irc_nick) return;

    console.log(`[quit] Attemping to change nick to ${irc_nick}`);
    ircClient.send("NICK", irc_nick);

    // Assume that it works, or at least limit it to a single attempt
    ircClient.removeListener('quit', nickReclaimListener);
  }

  ircClient.connect(function(registrationMessage) {
    console.log("[connecting] ("+method+"/"+username+") Connecting to IRC... Channels: "+[config.channels.map((c) => c.irc)].join());
    const realNick = registrationMessage.args[0];
    if (username == realNick) return;
    console.log(`[connecting] IRC nick was set to "${realNick}", will now listen for part events to reclaim nick "${irc_nick}"`);

    ircClient.addListener('quit', nickReclaimListener);
  });

  ircClient.addListener('join', function(channel, nick, message) {
    console.log(`[join] ${nick} joined ${channel} (me: ${ircClient.nick})`);

    // Bail if it's not about us
    if (nick != ircClient.nick) return;

    console.log(`[debug] ${irc_nick} successfully joined ${channel}! (joined as ${nick})`);

    // Bail if there are no queued messages for the channel
    if (!queued[clientId]) return;

    // Delay to give Loqi time to +v
    setTimeout(function() {
      let text;
      while (text = queued[clientId].pop(channel)) {
        ircClient.say(channel, text);
      }
    }, 500);
  });

  ircClient.addListener('error', function(message) {
    console.log("[error] ("+method+"/"+username+") ", message);
  });

  ircClient.addListener('pm', function(from, message) {
    ircClient.say(from, "[error] Sorry, private messages to users of the "+method+" gateway are not supported.");
  })
}
