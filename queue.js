
exports.queue = function() {
  this.messages = {};

  this.push = function(channel, text) {
    if(!this.messages[channel])
      this.messages[channel] = [];

    this.messages[channel].push(text);
  }

  this.length = function() {
    var len = 0;
    for(var c in this.messages) {
      len += this.messages[c].length;
    }
    return len;
  }

  this.pop = function(channel) {
    if(!this.messages[channel])
      return false;

    return this.messages[channel].shift();
  }

};
