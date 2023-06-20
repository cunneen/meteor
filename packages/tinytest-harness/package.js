Package.describe({
  name: 'tinytest-harness',
  version: '1.0.0-alpha300.10',
  summary: 'In development, lets your app define Tinytests, run them and see results',
  documentation: null
});

Package.onUse(function(api) {
  // XXX this needs to change. We'll probably have `testOnly` a la
  // `debugOnly`.
  if (global.testCommandMetadata) {
    api.imply('tinytest');
    api.imply('test-helpers');
    api.imply('test-in-browser');

    api.use('test-in-browser');

    api.export('runTests');
  }
});
