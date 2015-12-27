Slack IRC Gateway
=================

You can use this project to bridge a Slack room with an existing IRC channel.

When Slack users type a message, this script will sign in to IRC for them, join the 
channel, and then relays their messages to IRC on behalf of them.


Setup
-----

* Choose a Slack channel and configure a "web hook" integration for it.
* Set the URL of the web hook to the location of where you deployed this script. It should be something like http://example.com:8080/gateway/input
* Get a token for your Slack account from https://api.slack.com/web and add it to the config file.
* Set the hostname and channel for the IRC server you're connecting to in the config file.

Now run gateway.js which listens on the configured HTTP port and will start connecting to IRC on behalf of your Slack users!

Todo
----

Currently this only supports getting messages from Slack to an IRC channel. To get messages back from IRC to Slack, you need to run a separate bot that sends post requests to a Slack incoming web hook. Ideally that component should also be handled by this project.


License
-------

See LICENSE.txt
