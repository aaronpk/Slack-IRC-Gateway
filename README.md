Slack IRC Gateway
=================

You can use this project to bridge a Slack room with an existing IRC channel.

When Slack users type a message, this script will sign in to IRC for them, join the
channel, and then relays their messages to IRC on behalf of them.


Setup
-----

* Choose a Slack channel and configure a new custom app for it
* Enable Event Subscriptions on the app
* Set the Request URL to the location of where you deployed this script. It should be something like http://example.com:8080/gateway/input
  * Make sure you deploy the app before setting this URL, as Slack will ping it to test it when you enter the URL
  * Watch the logs and copy the "Event API Token" into your config
* Under "Subscribe to events on behalf of users", add the `message.channels` event
* Under "OAuth & Permissions", add the following User Token Scopes
  * `channels:history`
  * `channels:read`
  * `files:read`
  * `files:write`
  * `groups:read`
  * `users:read`
  * (Some of these may already be added when you configure `message.channels` in the previous step)
* Copy the OAuth Access Token and add it to the config file in `slack.token`. This is used to do things like look up info about Slack users.
* Create an incoming web hook (legacy, not within this app) to route messages back into slack, and set that as `slack.hook` in the config file.
* Set the hostname and channel for the IRC server you're connecting to in the config file.

Now run `node gateway.js` which listens on the configured HTTP port and will start connecting to IRC on behalf of your Slack users!

Messages from IRC will also be sent back to the corresponding channel.


Text Replacements
-----------------

Slack supports rich text in messages such as including links. If you have any custom text replacements you'd like to do for messages sent from IRC to Slack, such as autolinking keywords, you can add a file `replacements.js` and define a function there to transform text sent from IRC to Slack. See `replacements.example.js` for an example.


License
-------

See LICENSE.txt
