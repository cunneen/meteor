if (Meteor.isServer) {
  // XXX namespacing
  var Future = __meteor_bootstrap__.require('fibers/future');
}

// list of subscription tokens outstanding during a
// captureDependencies run. only set when we're doing a run. The fact
// that this is a singleton means we can't do recursive
// Meteor.subscriptions(). But what would that even mean?
// XXX namespacing
Meteor._capture_subs = null;

// @param url {Function|String|Object} URL or URL-producing function to Meteor
//     app or sockjs endpoint (deprecated), or an object as a test hook (see
//     code)
Meteor._LivedataConnection = function (url, restart_on_update) {
  var self = this;

  self.last_session_id = null;
  self.stores = {}; // name -> object with methods
  self.method_handlers = {}; // name -> func
  self.next_method_id = 1;
  // waiting for results of method
  self.outstanding_methods = []; // each item has keys: msg, callback
  // waiting for data from method
  self.unsatisfied_methods = {}; // map from method_id -> true
  // sub was ready, is no longer (due to reconnect)
  self.unready_subscriptions = {}; // map from sub._id -> true
  // messages from the server that have not been applied
  self.pending_data = []; // array of pending data messages
  // name -> updates for (yet to be created) collection
  self.queued = {};
  // if we're blocking a migration, the retry func
  self._retryMigrate = null;

  // metadata for subscriptions
  self.subs = new LocalCollection;
  // keyed by subs._id. value is unset or an array. if set, sub is not
  // yet ready.
  self.sub_ready_callbacks = {};

  // just for testing
  self.quiesce_callbacks = [];


  // Setup auto-reload persistence.
  Meteor._reload.onMigrate(function (retry) {
    if (!self._readyToMigrate()) {
      if (self._retryMigrate)
        throw new Error("Two migrations in progress?");
      self._retryMigrate = retry;
      return false;
    }

    return [true];
  });

  // Set up stream. As a test hook, allow passing a stream instead of an url or
  // url-producing function.
  if (typeof url === "object") {
    self.stream = url;
  } else {
    self.stream = new Meteor._Stream(url);
  }

  self.stream.on('message', function (raw_msg) {
    try {
      var msg = JSON.parse(raw_msg);
    } catch (err) {
      Meteor._debug("discarding message with invalid JSON", raw_msg);
      return;
    }
    if (typeof msg !== 'object' || !msg.msg) {
      Meteor._debug("discarding invalid livedata message", msg);
      return;
    }

    if (msg.msg === 'connected')
      self._livedata_connected(msg);
    else if (msg.msg === 'data')
      self._livedata_data(msg);
    else if (msg.msg === 'nosub')
      self._livedata_nosub(msg);
    else if (msg.msg === 'result')
      self._livedata_result(msg);
    else if (msg.msg === 'error')
      self._livedata_error(msg);
    else
      Meteor._debug("discarding unknown livedata message type", msg);
  });

  self.stream.on('reset', function () {

    // Send a connect message at the beginning of the stream.
    // NOTE: reset is called even on the first connection, so this is
    // the only place we send this message.
    var msg = {msg: 'connect'};
    if (self.last_session_id)
      msg.session = self.last_session_id;
    self.stream.send(JSON.stringify(msg));

    // Now, to minimize setup latency, go ahead and blast out all of
    // our pending methods ands subscriptions before we've even taken
    // the necessary RTT to know if we successfully reconnected. (1)
    // They're supposed to be idempotent; (2) even if we did
    // reconnect, we're not sure what messages might have gotten lost
    // (in either direction) since we were disconnected (TCP being
    // sloppy about that.)

    // XXX we may have an issue where we lose 'data' messages sent
    // immediately before disconnection.. do we need to add app-level
    // acking of data messages?

    // Send pending methods.
    _.each(self.outstanding_methods, function (m) {
      self.stream.send(JSON.stringify(m.msg));
    });

    // add new subscriptions at the end. this way they take effect after
    // the handlers and we don't see flicker.
    self.subs.find().forEach(function (sub) {
      self.stream.send(JSON.stringify(
        {msg: 'sub', id: sub._id, name: sub.name, params: sub.args}));
    });
  });

  if (restart_on_update)
    self.stream.on('update_available', function () {
      // Start trying to migrate to a new version. Until all packages
      // signal that they're ready for a migration, the app will
      // continue running normally.
      Meteor._reload.reload();
    });

  // we never terminate the observe(), since there is no way to
  // destroy a LivedataConnection.. but this shouldn't matter, since we're
  // the only one that holds a reference to the self.subs collection
  self.subs_token = self.subs.find({}).observe({
    added: function (sub) {
      self.stream.send(JSON.stringify({
        msg: 'sub', id: sub._id, name: sub.name, params: sub.args}));
    },
    changed: function (sub) {
      if (sub.count <= 0) {
        // minimongo not re-entrant.
        _.defer(function () { self.subs.remove({_id: sub._id}); });
      }
    },
    removed: function (obj) {
      self.stream.send(JSON.stringify({msg: 'unsub', id: obj._id}));
    }
  });
};

_.extend(Meteor._LivedataConnection.prototype, {
  // 'name' is the name of the data on the wire that should go in the
  // store. 'store' should be an object with methods beginUpdate,
  // update, endUpdate, reset. see Collection for an example.
  registerStore: function (name, store) {
    var self = this;

    if (name in self.stores)
      return false;
    self.stores[name] = store;

    var queued = self.queued[name] || [];
    store.beginUpdate(queued.length);
    _.each(queued, function (msg) {
      store.update(msg);
    });
    store.endUpdate();
    delete self.queued[name];

    return true;
  },

  subscribe: function (name /* .. [arguments] .. callback */) {
    var self = this;
    var id;

    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length && typeof args[args.length - 1] === "function")
      var callback = args.pop();

    var existing = self.subs.find({name: name, args: args}, {reactive: false}).fetch();

    if (existing && existing[0]) {
      // already subbed, inc count.
      id = existing[0]._id;
      self.subs.update({_id: id}, {$inc: {count: 1}});

      if (callback) {
        if (self.sub_ready_callbacks[id])
          self.sub_ready_callbacks[id].push(callback);
        else
          callback(); // XXX maybe _.defer?
      }
    } else {
      // new sub, add object.
      // generate our own id so we can know it w/ a find afterwards.
      id = LocalCollection.uuid();
      self.subs.insert({_id: id, name: name, args: args, count: 1});

      self.sub_ready_callbacks[id] = [];

      if (callback)
        self.sub_ready_callbacks[id].push(callback);
    }

    // return an object with a stop method.
    var token = {stop: function () {
      if (!id) return; // must have an id (local from above).
      // just update the database. observe takes care of the rest.
      self.subs.update({_id: id}, {$inc: {count: -1}});
    }};

    if (Meteor._capture_subs)
      Meteor._capture_subs.push(token);

    return token;
  },

  methods: function (methods) {
    var self = this;
    _.each(methods, function (func, name) {
      if (self.method_handlers[name])
        throw new Error("A method named '" + name + "' is already defined");
      self.method_handlers[name] = func;
    });
  },

  call: function (name /* .. [arguments] .. callback */) {
    // if it's a function, the last argument is the result callback,
    // not a parameter to the remote method.
    var args = Array.prototype.slice.call(arguments, 1);
    if (args.length && typeof args[args.length - 1] === "function")
      var callback = args.pop();
    return this.apply(name, args, callback);
  },

  apply: function (name, args, callback) {
    var self = this;
    var enclosing = Meteor._CurrentInvocation.get();

    if (callback)
      // XXX would it be better form to do the binding in stream.on,
      // or caller, instead of here?
      callback = Meteor.bindEnvironment(callback, function (e) {
        // XXX improve error message (and how we report it)
        Meteor._debug("Exception while delivering result of invoking '" +
                      name + "'", e.stack);
      });

    var isSimulation = enclosing && enclosing.isSimulation;
    if (Meteor.isClient) {
      // If on a client, run the stub, if we have one. The stub is
      // supposed to make some temporary writes to the database to
      // give the user a smooth experience until the actual result of
      // executing the method comes back from the server (whereupon
      // the temporary writes to the database will be reversed during
      // the beginUpdate/endUpdate process.)
      //
      // Normally, we ignore the return value of the stub (even if it
      // is an exception), in favor of the real return value from the
      // server. The exception is if the *caller* is a stub. In that
      // case, we're not going to do a RPC, so we use the return value
      // of the stub as our return value.
      var stub = self.method_handlers[name];
      if (stub) {
        var invocation = new Meteor._MethodInvocation(true /* isSimulation */);
        try {
          var ret = Meteor._CurrentInvocation.withValue(invocation,function () {
            return stub.apply(invocation, args);
          });
        }
        catch (e) {
          var exception = e;
        }
      }

      // If we're in a simulation, stop and return the result we have,
      // rather than going on to do an RPC. This can only happen on
      // the client (since we only bother with stubs and simulations
      // on the client.) If there was not stub, we'll end up returning
      // undefined.
      if (isSimulation) {
        if (callback) {
          callback(exception, ret);
          return;
        }
        if (exception)
          throw exception;
        return ret;
      }

      // If an exception occurred in a stub, and we're ignoring it
      // because we're doing an RPC and want to use what the server
      // returns instead, log it so the developer knows.
      //
      // Tests can set the 'expected' flag on an exception so it won't
      // go to log.
      if (exception && !exception.expected)
        Meteor._debug("Exception while simulating the effect of invoking '" +
                      name + "'", exception.stack);
    }

    // At this point we're definitely doing an RPC, and we're going to
    // return the value of the RPC to the caller.

    // If the caller didn't give a callback, decide what to do.
    if (!callback) {
      if (Meteor.isClient)
        // On the client, we don't have fibers, so we can't block. The
        // only thing we can do is to return undefined and discard the
        // result of the RPC.
        callback = function () {};
      else {
        // On the server, make the function synchronous.
        var future = new Future;
        callback = function (err, result) {
          future['return']([err, result]);
        };
      }
    }

    // Send the RPC. Note that on the client, it is important that the
    // stub have finished before we send the RPC (or at least we need
    // to guaranteed that the snapshot is not restored until the stub
    // has stopped doing writes.)
    var msg = {
      msg: 'method',
      method: name,
      params: args,
      id: '' + (self.next_method_id++)
    };
    self.outstanding_methods.push({msg: msg, callback: callback});
    self.unsatisfied_methods[msg.id] = true;
    self.stream.send(JSON.stringify(msg));

    // If we're using the default callback on the server,
    // synchronously return the result from the remote host.
    if (future) {
      var outcome = future.wait();
      if (outcome[0])
        throw outcome[0];
      return outcome[1];
    }
  },

  status: function () {
    var self = this;
    return self.stream.status();
  },

  reconnect: function () {
    var self = this;
    return self.stream.reconnect();
  },

  // PRIVATE: called when we are up-to-date with the server. intended
  // for use only in tests. currently, you are very limited in what
  // you may do inside your callback -- in particular, don't do
  // anything that could result in another call to onQuiesce, or
  // results are undefined.
  onQuiesce: function (f) {
    var self = this;

    f = Meteor.bindEnvironment(f, function (e) {
      Meteor._debug("Exception in quiesce callback", e.stack);
    });

    for (var method_id in self.unsatisfied_methods) {
      // we are not quiesced -- wait until we are
      self.quiesce_callbacks.push(f);
      return;
    }

    f();
  },

  _livedata_connected: function (msg) {
    var self = this;

    if (typeof (msg.session) === "string") {
      var reconnected = (self.last_session_id === msg.session);
      self.last_session_id = msg.session;
    }

    if (reconnected)
      // successful reconnection -- pick up where we left off.
      return;

    // Server doesn't have our data any more. Re-sync a new session.

    // Put a reset message into the pending data queue and discard any
    // previous messages (they are unimportant now).
    self.pending_data = ["reset"];
    self.queued = {};

    // Mark all currently ready subscriptions as 'unready'.
    var all_subs = self.subs.find({}).fetch();
    self.unready_subscriptions = {};
    _.each(all_subs, function (sub) {
      if (!self.sub_ready_callbacks[sub._id])
        self.unready_subscriptions[sub._id] = true;
    });

    // Do not clear the database here. That happens once all the subs
    // are re-ready and we process pending_data.
  },

  _livedata_data: function (msg) {
    var self = this;

    // Add the data message to the queue
    self.pending_data.push(msg);

    // Process satisfied methods and subscriptions.
    // NOTE: does not fire callbacks here, that happens when
    // the data message is processed for real. This is just for
    // quiescing.
    _.each(msg.methods || [], function (method_id) {
      delete self.unsatisfied_methods[method_id];
    });
    _.each(msg.subs || [], function (sub_id) {
      delete self.unready_subscriptions[sub_id];
    });

    // If there are still method invocations in flight, stop
    for (var method_id in self.unsatisfied_methods)
      return;
    // If there are still uncomplete subscriptions, stop
    for (var sub_id in self.unready_subscriptions)
      return;

    // We have quiesced. Blow away local changes and replace
    // with authoritative changes from server.

    var messagesPerStore = {};
    _.each(self.pending_data, function (msg) {
      if (msg.collection && msg.id && self.stores[msg.collection]) {
        if (_.has(messagesPerStore, msg.collection))
          ++messagesPerStore[msg.collection];
        else
          messagesPerStore[msg.collection] = 1;
      }
    });

    _.each(self.stores, function (s, name) {
      s.beginUpdate(_.has(messagesPerStore, name) ? messagesPerStore[name] : 0);
    });

    _.each(self.pending_data, function (msg) {
      // Reset message from reconnect. Blow away everything.
      //
      // XXX instead of reset message, we could have a flag, and pass
      // that to beginUpdate. This would be more efficient since we don't
      // have to restore a snapshot if we're just going to blow away the
      // db.
      if (msg === "reset") {
        _.each(self.stores, function (s) { s.reset(); });
        return;
      }

      if (msg.collection && msg.id) {
        var store = self.stores[msg.collection];

        if (!store) {
          // Nobody's listening for this data. Queue it up until
          // someone wants it.
          // XXX memory use will grow without bound if you forget to
          // create a collection.. going to have to do something about
          // that.
          if (!(msg.collection in self.queued))
            self.queued[msg.collection] = [];
          self.queued[msg.collection].push(msg);
          return;
        }

        store.update(msg);
      }

      if (msg.subs) {
        _.each(msg.subs, function (id) {
          var arr = self.sub_ready_callbacks[id];
          if (arr) _.each(arr, function (c) { c(); });
          delete self.sub_ready_callbacks[id];
        });
      }
    });

    _.each(self.stores, function (s) { s.endUpdate(); });

    _.each(self.quiesce_callbacks, function (cb) { cb(); });
    self.quiesce_callbacks = [];

    self.pending_data = [];
  },

  _livedata_nosub: function (msg) {
    var self = this;
    // Meteor._debug("NOSUB", msg);
  },

  _livedata_result: function (msg) {
    var self = this;
    // id, result or error. error has error (code), reason, details

    // find the outstanding request
    // should be O(1) in nearly all realistic use cases
    for (var i = 0; i < self.outstanding_methods.length; i++) {
      var m = self.outstanding_methods[i];
      if (m.msg.id === msg.id)
        break;
    }
    if (!m) {
      // XXX write a better error
      Meteor._debug("Can't interpret method response message");
      return;
    }

    // remove
    self.outstanding_methods.splice(i, 1);

    // deliver result
    if (m.callback) {
      // callback will have already been bindEnvironment'd by apply(),
      // so no need to catch exceptions
      if ('error' in msg)
        m.callback(new Meteor.Error(msg.error.error, msg.error.reason,
                                    msg.error.details));
      else
        // msg.result may be undefined if the method didn't return a
        // value
        m.callback(undefined, msg.result);
    }

    // if we were blocking a migration, see if it's now possible to
    // continue
    if (self._retryMigrate && self._readyToMigrate()) {
      self._retryMigrate();
      self._retryMigrate = null;
    }
  },

  _livedata_error: function (msg) {
    Meteor._debug("Received error from server: ", msg.reason);
    if (msg.offending_message)
      Meteor._debug("For: ", msg.offending_message);
  },

  // true if we're OK for a migration to happen
  _readyToMigrate: function () {
    var self = this;
    return self.outstanding_methods.length === 0;
  }
});

_.extend(Meteor, {
  // @param url {String|Function} URL or URL-producing function to Meteor app,
  //   or to sockjs endpoint (deprecated),
  //     e.g.:
  //     "subdomain.meteor.com",
  //     "http://subdomain.meteor.com",
  //     "/",
  //     "http://subdomain.meteor.com/sockjs" (deprecated),
  //     "/sockjs" (deprecated)
  connect: function (url, _restartOnUpdate) {
    var ret = new Meteor._LivedataConnection(url, _restartOnUpdate);
    Meteor._LivedataConnection._allConnections.push(ret); // hack. see below.
    return ret;
  },

  autosubscribe: function (sub_func) {
    var local_subs = [];
    var context = new Meteor.deps.Context();

    context.onInvalidate(function () {
      // recurse.
      Meteor.autosubscribe(sub_func);
      // unsub after re-subbing, to avoid bouncing.
      _.each(local_subs, function (x) { x.stop(); });
    });

    context.run(function () {
      if (Meteor._capture_subs)
        throw new Error("Meteor.autosubscribe may not be called recursively");

      Meteor._capture_subs = [];
      try {
        sub_func();
      } finally {
        local_subs = Meteor._capture_subs;
        Meteor._capture_subs = null;
      }
    });
  }
});


// Hack for `spiderable` package: a way to see if the page is done
// loading all the data it needs.
Meteor._LivedataConnection._allConnections = [];
Meteor._LivedataConnection._allSubscriptionsReady = function () {
  return _.all(Meteor._LivedataConnection._allConnections, function (conn) {
    for (var k in conn.sub_ready_callbacks)
      return false;
    return true;
  });
};
