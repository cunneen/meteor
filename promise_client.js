// See https://github.com/then/promise#usage for an explanation of why we
// require promise/domains here.
var MeteorPromise = require("promise/domains");

var es6PromiseThen = MeteorPromise.prototype.then;
MeteorPromise.prototype.then = function (onResolved, onRejected) {
  if (typeof Meteor === "object" &&
      typeof Meteor.bindEnvironment === "function") {
    return es6PromiseThen.call(
      this,
      onResolved && Meteor.bindEnvironment(onResolved),
      onRejected && Meteor.bindEnvironment(onRejected)
    );
  }
  return es6PromiseThen.call(this, onResolved, onRejected);
};

Promise = MeteorPromise;
