Slack IRC Gateway
=================

You can use this project to bridge a Slack room with an existing IRC channel.

When Slack users type a message, this script will sign in to IRC for them, join the
channel, and then relays their messages to IRC on behalf of them.


Setup
-----

* Choose a Slack channel and configure a "web hook" integration for it.
* Set the URL of the web hook to the location of where you deployed this script. It should be something like http://example.com:8080/gateway/input
* Get a token for your Slack account from https://api.slack.com/web and add it to the config file in `slack.token`. This is used to do things like look up info about Slack users.
* Create an incoming web hook to route messages back into slack, and set that as `slack.hook` in the config file.
* Set the hostname and channel for the IRC server you're connecting to in the config file.

Now run gateway.js which listens on the configured HTTP port and will start connecting to IRC on behalf of your Slack users!

Messages from IRC will also be sent back to the corresponding channel.


Text Replacements
-----------------

Slack supports rich text in messages such as including links. If you have any custom text replacements you'd like to do for messages sent from IRC to Slack, such as autolinking keywords, you can add a file `replacements.js` and define a function there to transform text sent from IRC to Slack. See `replacements.example.js` for an example.


License
-------

See LICENSE.txt
