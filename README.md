# mt-node-gateway-lib

This app abstracts three gateway functions: communicating with major tom over a WebSocket connection, communicating with major tom over a REST connection, and communicating with Systems over a WebSocket connection, through an API.

`example-app.js` is an example implementation of using the library with a bare bones console output.

### To Run The Example App Locally

```sh
$ git clone <this-repo>
$ cd ./mt-node-gateway-lib
$ npm install
$ node example/example-app.js wss://<your Major Tom instance url> <Your gateway token> [<Basic Auth Username>] [<Basic Auth Password>]
```

This will start the localhost gateway app running.

### To Connect Systems

The example app is designed to accept connections from Systems over a WebSocket. For that purpose, it runs a WebSocket server to listen for connections. The port where the WebSocket connection can be made will output to console when the app starts.

For custom implementation, users may use the provided WebSocket API, or may use their own implementation to connect to systems.

