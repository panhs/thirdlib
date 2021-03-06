'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.UNDEFINED_INPUT_ERROR = exports.INVALID_BUFFER = exports.isEnd = exports.END = undefined;
exports.emitter = emitter;
exports.channel = channel;
exports.eventChannel = eventChannel;

var _utils = require('./utils');

var _buffers = require('./buffers');

var CHANNEL_END_TYPE = '@@redux-saga/CHANNEL_END';
var END = exports.END = { type: CHANNEL_END_TYPE };
var isEnd = exports.isEnd = function isEnd(a) {
  return a && a.type === CHANNEL_END_TYPE;
};

function emitter() {
  var subscribers = [];

  function subscribe(sub) {
    subscribers.push(sub);
    return function () {
      return (0, _utils.remove)(subscribers, sub);
    };
  }

  function emit(item) {
    var arr = subscribers.slice();
    for (var i = 0, len = arr.length; i < len; i++) {
      arr[i](item);
    }
  }

  return {
    subscribe: subscribe,
    emit: emit
  };
}

var INVALID_BUFFER = exports.INVALID_BUFFER = 'invalid buffer passed to channel factory function';
var UNDEFINED_INPUT_ERROR = exports.UNDEFINED_INPUT_ERROR = 'Saga was provided with an undefined action';

if (process.env.NODE_ENV !== 'production') {
  exports.UNDEFINED_INPUT_ERROR = UNDEFINED_INPUT_ERROR += '\nHints:\n    - check that your Action Creator returns a non-undefined value\n    - if the Saga was started using runSaga, check that your subscribe source provides the action to its listeners\n  ';
}

function channel(buffer) {
  var closed = false;
  var takers = [];

  if (arguments.length > 0) {
    (0, _utils.check)(buffer, _utils.is.buffer, INVALID_BUFFER);
  } else {
    buffer = _buffers.buffers.fixed();
  }

  function checkForbiddenStates() {
    if (closed && takers.length) {
      throw (0, _utils.internalErr)('Cannot have a closed channel with pending takers');
    }
    if (takers.length && !buffer.isEmpty()) {
      throw (0, _utils.internalErr)('Cannot have pending takers with non empty buffer');
    }
  }

  function put(input) {
    checkForbiddenStates();
    (0, _utils.check)(input, _utils.is.notUndef, UNDEFINED_INPUT_ERROR);
    if (!closed) {
      if (takers.length) {
        for (var i = 0; i < takers.length; i++) {
          var cb = takers[i];
          if (!cb[_utils.MATCH] || cb[_utils.MATCH](input)) {
            takers.splice(i, 1);
            return cb(input);
          }
        }
      } else {
        buffer.put(input);
      }
    }
  }

  function take(cb, matcher) {
    checkForbiddenStates();
    (0, _utils.check)(cb, _utils.is.func, 'channel.take\'s callback must be a function');
    if (arguments.length > 1) {
      (0, _utils.check)(matcher, _utils.is.func, 'channel.take\'s matcher argument must be a function');
      cb[_utils.MATCH] = matcher;
    }
    if (closed && buffer.isEmpty()) {
      cb(END);
    } else if (!buffer.isEmpty()) {
      cb(buffer.take());
    } else {
      takers.push(cb);
      cb.cancel = function () {
        return (0, _utils.remove)(takers, cb);
      };
    }
  }

  function close() {
    checkForbiddenStates();
    if (!closed) {
      closed = true;
      if (takers.length) {
        var arr = takers;
        takers = [];
        for (var i = 0, len = arr.length; i < len; i++) {
          arr[i](END);
        }
        takers = [];
      }
    }
  }

  return { take: take, put: put, close: close,
    get __takers__() {
      return takers;
    },
    get __closed__() {
      return closed;
    }
  };
}

function eventChannel(subscribe) {
  var buffer = arguments.length <= 1 || arguments[1] === undefined ? _buffers.buffers.none() : arguments[1];
  var matcher = arguments[2];

  /**
    should be if(typeof matcher !== undefined) instead?
    see PR #273 for a background discussion
  **/
  if (arguments.length > 2) {
    (0, _utils.check)(matcher, _utils.is.func, 'Invalid match function passed to eventChannel');
  }

  var chan = channel(buffer);
  var unsubscribe = subscribe(function (input) {
    if (isEnd(input)) {
      chan.close();
    } else if (!matcher || matcher(input)) {
      chan.put(input);
    }
  });

  if (!_utils.is.func(unsubscribe)) {
    throw new Error('in eventChannel: subscribe should return a function to unsubscribe');
  }

  return {
    take: chan.take,
    close: function close() {
      if (!chan.__closed__) {
        chan.close();
        unsubscribe();
      }
    }
  };
}