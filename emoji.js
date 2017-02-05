const punycode = require('punycode');

var emoji_data = require('./emoji_pretty.json');

exports.slack_to_unicode = function(text) {

  var emoji_re = /\:([a-zA-Z0-9\-_\+]+)\:(?:\:([a-zA-Z0-9\-_\+]+)\:)?/g;

  var new_text = text;

  // Find all Slack emoji in the message
  while(match=emoji_re.exec(text)) {
    var ed = emoji_data.find(function(el){
      return el.short_name == match[1];
    });
    if(ed) {
      var points = ed.unified.split("-");
      points = points.map(function(p){ return parseInt(p, 16) });
      new_text = new_text.replace(match[0], punycode.ucs2.encode(points));
    }
  }

  return new_text;
}
