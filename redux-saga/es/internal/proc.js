function _defineEnumerableProperties(obj, descs) { for (var key in descs) { var desc = descs[key]; desc.configurable = desc.enumerable = true; if ("value" in desc) desc.writable = true; Object.defineProperty(obj, key, desc); } return obj; }

function _toConsumableArray(arr) { if (Array.isArray(arr)) { for (var i = 0, arr2 = Array(arr.length); i < arr.length; i++) { arr2[i] = arr[i]; } return arr2; } else { return Array.from(arr); } }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

import { noop, kTrue, is, log as _log, check, deferred, autoInc, remove, TASK, CANCEL, makeIterator } from './utils';
import asap from './asap';
import { asEffect } from './io';
import { eventChannel, isEnd } from './channel';
import { buffers } from './buffers';

var isDev = process.env.NODE_ENV === 'development';

export var NOT_ITERATOR_ERROR = 'proc first argument (Saga function result) must be an iterator';

var nextEffectId = autoInc();
export var CHANNEL_END = {
  toString: function toString() {
    return '@@redux-saga/CHANNEL_END';
  }
};
export var TASK_CANCEL = {
  toString: function toString() {
    return '@@redux-saga/TASK_CANCEL';
  }
};

var matchers = {
  wildcard: function wildcard() {
    return kTrue;
  },
  default: function _default(pattern) {
    return function (input) {
      return input.type === pattern;
    };
  },
  array: function array(patterns) {
    return function (input) {
      return patterns.some(function (p) {
        return p === input.type;
      });
    };
  },
  predicate: function predicate(_predicate) {
    return function (input) {
      return _predicate(input);
    };
  }
};

function matcher(pattern) {
  return (pattern === '*' ? matchers.wildcard : is.array(pattern) ? matchers.array : is.func(pattern) ? matchers.predicate : matchers.default)(pattern);
}

/**
  Used to track a parent task and its forks
  In the new fork model, forked tasks are attached by default to their parent
  We model this using the concept of Parent task && main Task
  main task is the main flow of the current Generator, the parent tasks is the
  aggregation of the main tasks + all its forked tasks.
  Thus the whole model represents an execution tree with multiple branches (vs the
  linear execution tree in sequential (non parallel) programming)

  A parent tasks has the following semantics
  - It completes iff all its forks either complete or all cancelled
  - If it's cancelled, all forks are cancelled as well
  - It aborts if any uncaught error bubbles up from forks
  - If it completes, the return value is the one returned by the main task
**/
function forkQueue(name, mainTask, cb) {
  var tasks = [],
      result = void 0,
      completed = false;
  addTask(mainTask);

  function abort(err) {
    cancelAll();
    cb(err, true);
  }

  function addTask(task) {
    tasks.push(task);
    task.cont = function (res, isErr) {
      if (completed) {
        return;
      }

      remove(tasks, task);
      task.cont = noop;
      if (isErr) {
        abort(res);
      } else {
        if (task === mainTask) {
          result = res;
        }
        if (!tasks.length) {
          completed = true;
          cb(result);
        }
      }
    };
    // task.cont.cancel = task.cancel
  }

  function cancelAll() {
    if (completed) {
      return;
    }
    completed = true;
    tasks.forEach(function (t) {
      t.cont = noop;
      t.cancel();
    });
    tasks = [];
  }

  return {
    addTask: addTask,
    cancelAll: cancelAll,
    abort: abort,
    getTasks: function getTasks() {
      return tasks;
    },
    taskNames: function taskNames() {
      return tasks.map(function (t) {
        return t.name;
      });
    }
  };
}

export default function proc(iterator) {
  var subscribe = arguments.length <= 1 || arguments[1] === undefined ? function () {
    return noop;
  } : arguments[1];
  var dispatch = arguments.length <= 2 || arguments[2] === undefined ? noop : arguments[2];
  var getState = arguments.length <= 3 || arguments[3] === undefined ? noop : arguments[3];
  var options = arguments.length <= 4 || arguments[4] === undefined ? {} : arguments[4];
  var parentEffectId = arguments.length <= 5 || arguments[5] === undefined ? 0 : arguments[5];
  var name = arguments.length <= 6 || arguments[6] === undefined ? 'anonymous' : arguments[6];
  var cont = arguments[7];

  check(iterator, is.iterator, NOT_ITERATOR_ERROR);

  var sagaMonitor = options.sagaMonitor;
  var logger = options.logger;

  var log = logger || _log;
  var stdChannel = eventChannel(subscribe);
  /**
    Tracks the current effect cancellation
    Each time the generator progresses. calling runEffect will set a new value
    on it. It allows propagating cancellation to child effects
  **/
  next.cancel = noop;

  /**
    Creates a new task descriptor for this generator, We'll also create a main task
    to track the main flow (besides other forked tasks)
  **/
  var task = newTask(parentEffectId, name, iterator, cont);
  var mainTask = { name: name, cancel: cancelMain, isRunning: true };
  var taskQueue = forkQueue(name, mainTask, end);

  /**
    cancellation of the main task. We'll simply resume the Generator with a Cancel
  **/
  function cancelMain() {
    if (mainTask.isRunning && !mainTask.isCancelled) {
      mainTask.isCancelled = true;
      next(TASK_CANCEL);
    }
  }

  /**
    This may be called by a parent generator to trigger/propagate cancellation
    cancel all pending tasks (including the main task), then end the current task.
      Cancellation propagates down to the whole execution tree holded by this Parent task
    It's also propagated to all joiners of this task and their execution tree/joiners
      Cancellation is noop for terminated/Cancelled tasks tasks
  **/
  function cancel() {
    /**
      We need to check both Running and Cancelled status
      Tasks can be Cancelled but still Running
    **/
    if (iterator._isRunning && !iterator._isCancelled) {
      iterator._isCancelled = true;
      taskQueue.cancelAll();
      /**
        Ending with a Never result will propagate the Cancellation to all joiners
      **/
      end(TASK_CANCEL);
    }
  }
  /**
    attaches cancellation logic to this task's continuation
    this will permit cancellation to propagate down the call chain
  **/
  cont && (cont.cancel = cancel);

  // tracks the running status
  iterator._isRunning = true;

  // kicks up the generator
  next();

  // then return the task descriptor to the caller
  return task;

  /**
    This is the generator driver
    It's a recursive async/continuation function which calls itself
    until the generator terminates or throws
  **/
  function next(arg, isErr) {
    // Preventive measure. If we end up here, then there is really something wrong
    if (!mainTask.isRunning) {
      throw new Error('Trying to resume an already finished generator');
    }

    try {
      var result = void 0;
      if (isErr) {
        result = iterator.throw(arg);
      } else if (arg === TASK_CANCEL) {
        /**
          getting TASK_CANCEL autoamtically cancels the main task
          We can get this value here
            - By cancelling the parent task manually
          - By joining a Cancelled task
        **/
        mainTask.isCancelled = true;
        /**
          Cancels the current effect; this will propagate the cancellation down to any called tasks
        **/
        next.cancel();
        /**
          If this Generator has a `return` method then invokes it
          Thill will jump to the finally block
        **/
        result = is.func(iterator.return) ? iterator.return(TASK_CANCEL) : { done: true, value: TASK_CANCEL };
      } else if (arg === CHANNEL_END) {
        // We get CHANNEL_END by taking from a channel that ended using `take` (and not `takem` used to trap End of channels)
        result = is.func(iterator.return) ? iterator.return() : { done: true };
      } else {
        result = iterator.next(arg);
      }

      if (!result.done) {
        runEffect(result.value, parentEffectId, '', next);
      } else {
        /**
          This Generator has ended, terminate the main task and notify the fork queue
        **/
        mainTask.isMainRunning = false;
        mainTask.cont && mainTask.cont(result.value);
      }
    } catch (error) {
      if (mainTask.isCancelled) {
        log('error', 'uncaught at ' + name, error.message);
      }
      mainTask.isMainRunning = false;
      mainTask.cont(error, true);
    }
  }

  function end(result, isErr) {
    iterator._isRunning = false;
    stdChannel.close();
    if (!isErr) {
      if (result === TASK_CANCEL && isDev) {
        log('info', name + ' has been cancelled', '');
      }
      iterator._result = result;
      iterator._deferredEnd && iterator._deferredEnd.resolve(result);
    } else {
      if (result instanceof Error) {
        result.sagaStack = 'at ' + name + ' \n ' + (result.sagaStack || result.stack);
      }
      if (!task.cont) {
        log('error', 'uncaught', result.sagaStack || result.stack);
      }
      iterator._error = result;
      iterator._isAborted = true;
      iterator._deferredEnd && iterator._deferredEnd.reject(result);
    }
    task.cont && task.cont(result, isErr);
    task.joiners.forEach(function (j) {
      return j.cb(result, isErr);
    });
    task.joiners = null;
  }

  function runEffect(effect, parentEffectId) {
    var label = arguments.length <= 2 || arguments[2] === undefined ? '' : arguments[2];
    var cb = arguments[3];

    var effectId = nextEffectId();
    sagaMonitor && sagaMonitor.effectTriggered({ effectId: effectId, parentEffectId: parentEffectId, label: label, effect: effect });

    /**
      completion callback and cancel callback are mutually exclusive
      We can't cancel an already completed effect
      And We can't complete an already cancelled effectId
    **/
    var effectSettled = void 0;

    // Completion callback passed to the appropriate effect runner
    function currCb(res, isErr) {
      if (effectSettled) {
        return;
      }

      effectSettled = true;
      cb.cancel = noop; // defensive measure
      if (sagaMonitor) {
        isErr ? sagaMonitor.effectRejected(effectId, res) : sagaMonitor.effectResolved(effectId, res);
      }

      cb(res, isErr);
    }
    // tracks down the current cancel
    currCb.cancel = noop;

    // setup cancellation logic on the parent cb
    cb.cancel = function () {
      // prevents cancelling an already completed effect
      if (effectSettled) {
        return;
      }

      effectSettled = true;
      /**
        propagates cancel downward
        catch uncaught cancellations errors; since we can no longer call the completion
        callback, log errors raised during cancellations into the console
      **/
      try {
        currCb.cancel();
      } catch (err) {
        log('error', 'uncaught at ' + name, err.message);
      }
      currCb.cancel = noop; // defensive measure

      sagaMonitor && sagaMonitor.effectCancelled(effectId);
    };

    /**
      each effect runner must attach its own logic of cancellation to the provided callback
      it allows this generator to propagate cancellation downward.
        ATTENTION! effect runners must setup the cancel logic by setting cb.cancel = [cancelMethod]
      And the setup must occur before calling the callback
        This is a sort of inversion of control: called async functions are responsible
      of completing the flow by calling the provided continuation; while caller functions
      are responsible for aborting the current flow by calling the attached cancel function
        Library users can attach their own cancellation logic to promises by defining a
      promise[CANCEL] method in their returned promises
      ATTENTION! calling cancel must have no effect on an already completed or cancelled effect
    **/
    var data = void 0;
    return (
      // Non declarative effect
      is.promise(effect) ? resolvePromise(effect, currCb) : is.iterator(effect) ? resolveIterator(effect, effectId, name, currCb)

      // declarative effects
      : is.array(effect) ? runParallelEffect(effect, effectId, currCb) : is.notUndef(data = asEffect.take(effect)) ? runTakeEffect(data, currCb) : is.notUndef(data = asEffect.put(effect)) ? runPutEffect(data, currCb) : is.notUndef(data = asEffect.race(effect)) ? runRaceEffect(data, effectId, currCb) : is.notUndef(data = asEffect.call(effect)) ? runCallEffect(data, effectId, currCb) : is.notUndef(data = asEffect.cps(effect)) ? runCPSEffect(data, currCb) : is.notUndef(data = asEffect.fork(effect)) ? runForkEffect(data, effectId, currCb) : is.notUndef(data = asEffect.join(effect)) ? runJoinEffect(data, currCb) : is.notUndef(data = asEffect.cancel(effect)) ? runCancelEffect(data, currCb) : is.notUndef(data = asEffect.select(effect)) ? runSelectEffect(data, currCb) : is.notUndef(data = asEffect.actionChannel(effect)) ? runChannelEffect(data, currCb) : is.notUndef(data = asEffect.cancelled(effect)) ? runCancelledEffect(data, currCb) : /* anything else returned as is        */currCb(effect)
    );
  }

  function resolvePromise(promise, cb) {
    var cancelPromise = promise[CANCEL];
    if (typeof cancelPromise === 'function') {
      cb.cancel = cancelPromise;
    }
    promise.then(cb, function (error) {
      return cb(error, true);
    });
  }

  function resolveIterator(iterator, effectId, name, cb) {
    proc(iterator, subscribe, dispatch, getState, options, effectId, name, cb);
  }

  function runTakeEffect(_ref, cb) {
    var channel = _ref.channel;
    var pattern = _ref.pattern;
    var maybe = _ref.maybe;

    channel = channel || stdChannel;
    var takeCb = function takeCb(inp) {
      return inp instanceof Error ? cb(inp, true) : isEnd(inp) && !maybe ? cb(CHANNEL_END) : cb(inp);
    };
    try {
      channel.take(takeCb, matcher(pattern));
    } catch (err) {
      return cb(err, true);
    }
    cb.cancel = takeCb.cancel;
  }

  function runPutEffect(_ref2, cb) {
    var channel = _ref2.channel;
    var action = _ref2.action;
    var sync = _ref2.sync;

    /*
      Use a reentrant lock `asap` to flatten all nested dispatches
      If this put cause another Saga to take this action an then immediately
      put an action that will be taken by this Saga. Then the outer Saga will miss
      the action from the inner Saga b/c this put has not yet returned.
    */
    asap(function () {
      var result = void 0;
      try {
        result = (channel ? channel.put : dispatch)(action);
      } catch (error) {
        return cb(error, true);
      }

      if (sync && is.promise(result)) {
        resolvePromise(result, cb);
      } else {
        return cb(result);
      }
    });
    // Put effects are non cancellables
  }

  function runCallEffect(_ref3, effectId, cb) {
    var context = _ref3.context;
    var fn = _ref3.fn;
    var args = _ref3.args;

    var result = void 0;
    // catch synchronous failures; see #152
    try {
      result = fn.apply(context, args);
    } catch (error) {
      return cb(error, true);
    }
    return is.promise(result) ? resolvePromise(result, cb) : is.iterator(result) ? resolveIterator(result, effectId, fn.name, cb) : cb(result);
  }

  function runCPSEffect(_ref4, cb) {
    var context = _ref4.context;
    var fn = _ref4.fn;
    var args = _ref4.args;

    // CPS (ie node style functions) can define their own cancellation logic
    // by setting cancel field on the cb

    // catch synchronous failures; see #152
    try {
      fn.apply(context, args.concat(function (err, res) {
        return is.undef(err) ? cb(res) : cb(err, true);
      }));
    } catch (error) {
      return cb(error, true);
    }
  }

  function runForkEffect(_ref5, effectId, cb) {
    var context = _ref5.context;
    var fn = _ref5.fn;
    var args = _ref5.args;
    var detached = _ref5.detached;

    var result = void 0,
        error = void 0,
        _iterator = void 0;

    // we run the function, next we'll check if this is a generator function
    // (generator is a function that returns an iterator)

    // catch synchronous failures; see #152 and #441
    try {
      result = fn.apply(context, args);
    } catch (err) {
      error = err;
    }

    // A generator function: i.e. returns an iterator
    if (is.iterator(result)) {
      _iterator = result;
    }

    // do not bubble up synchronous failures for detached forks
    // instead create a failed task. See #152 and #441
    else {
        _iterator = error ? makeIterator(function () {
          throw error;
        }) : makeIterator(function () {
          var pc = void 0;
          var eff = { done: false, value: result };
          var ret = function ret(value) {
            return { done: true, value: value };
          };
          return function (arg) {
            if (!pc) {
              pc = true;
              return eff;
            } else {
              return ret(arg);
            }
          };
        }());
      }

    asap.suspend();
    var task = proc(_iterator, subscribe, dispatch, getState, options, effectId, fn.name, detached ? null : noop);
    if (detached) {
      cb(task);
    } else {
      if (_iterator._isRunning) {
        taskQueue.addTask(task);
        cb(task);
      } else if (_iterator._error) {
        taskQueue.abort(_iterator._error);
      } else {
        cb(task);
      }
    }
    asap.flush();
    // Fork effects are non cancellables
  }

  function runJoinEffect(t, cb) {
    if (t.isRunning()) {
      (function () {
        var joiner = { task: task, cb: cb };
        cb.cancel = function () {
          return remove(t.joiners, joiner);
        };
        t.joiners.push(joiner);
      })();
    } else {
      t.isAborted() ? cb(t.error(), true) : cb(t.result());
    }
  }

  function runCancelEffect(task, cb) {
    if (task.isRunning()) {
      task.cancel();
    }
    cb();
    // cancel effects are non cancellables
  }

  function runParallelEffect(effects, effectId, cb) {
    if (!effects.length) {
      return cb([]);
    }

    var completedCount = 0;
    var completed = void 0;
    var results = Array(effects.length);

    function checkEffectEnd() {
      if (completedCount === results.length) {
        completed = true;
        cb(results);
      }
    }

    var childCbs = effects.map(function (eff, idx) {
      var chCbAtIdx = function chCbAtIdx(res, isErr) {
        if (completed) {
          return;
        }
        if (isErr || isEnd(res) || res === CHANNEL_END || res === TASK_CANCEL) {
          cb.cancel();
          cb(res, isErr);
        } else {
          results[idx] = res;
          completedCount++;
          checkEffectEnd();
        }
      };
      chCbAtIdx.cancel = noop;
      return chCbAtIdx;
    });

    cb.cancel = function () {
      if (!completed) {
        completed = true;
        childCbs.forEach(function (chCb) {
          return chCb.cancel();
        });
      }
    };

    effects.forEach(function (eff, idx) {
      return runEffect(eff, effectId, idx, childCbs[idx]);
    });
  }

  function runRaceEffect(effects, effectId, cb) {
    var completed = void 0;
    var keys = Object.keys(effects);
    var childCbs = {};

    keys.forEach(function (key) {
      var chCbAtKey = function chCbAtKey(res, isErr) {
        if (completed) {
          return;
        }

        if (isErr) {
          // Race Auto cancellation
          cb.cancel();
          cb(res, true);
        } else if (!isEnd(res) && res !== CHANNEL_END && res !== TASK_CANCEL) {
          cb.cancel();
          completed = true;
          cb(_defineProperty({}, key, res));
        }
      };
      chCbAtKey.cancel = noop;
      childCbs[key] = chCbAtKey;
    });

    cb.cancel = function () {
      // prevents unnecessary cancellation
      if (!completed) {
        completed = true;
        keys.forEach(function (key) {
          return childCbs[key].cancel();
        });
      }
    };
    keys.forEach(function (key) {
      return runEffect(effects[key], effectId, key, childCbs[key]);
    });
  }

  function runSelectEffect(_ref6, cb) {
    var selector = _ref6.selector;
    var args = _ref6.args;

    try {
      var state = selector.apply(undefined, [getState()].concat(_toConsumableArray(args)));
      cb(state);
    } catch (error) {
      cb(error, true);
    }
  }

  function runChannelEffect(_ref7, cb) {
    var pattern = _ref7.pattern;
    var buffer = _ref7.buffer;

    var match = matcher(pattern);
    match.pattern = pattern;
    cb(eventChannel(subscribe, buffer || buffers.fixed(), match));
  }

  function runCancelledEffect(data, cb) {
    cb(!!mainTask.isCancelled);
  }

  function newTask(id, name, iterator, cont) {
    var _done, _ref8, _mutatorMap;

    iterator._deferredEnd = null;
    return _ref8 = {}, _defineProperty(_ref8, TASK, true), _defineProperty(_ref8, 'id', id), _defineProperty(_ref8, 'name', name), _done = 'done', _mutatorMap = {}, _mutatorMap[_done] = _mutatorMap[_done] || {}, _mutatorMap[_done].get = function () {
      if (iterator._deferredEnd) {
        return iterator._deferredEnd.promise;
      } else {
        var def = deferred();
        iterator._deferredEnd = def;
        if (!iterator._isRunning) {
          iterator._error ? def.reject(iterator._error) : def.resolve(iterator._result);
        }
        return def.promise;
      }
    }, _defineProperty(_ref8, 'cont', cont), _defineProperty(_ref8, 'joiners', []), _defineProperty(_ref8, 'cancel', cancel), _defineProperty(_ref8, 'isRunning', function isRunning() {
      return iterator._isRunning;
    }), _defineProperty(_ref8, 'isCancelled', function isCancelled() {
      return iterator._isCancelled;
    }), _defineProperty(_ref8, 'isAborted', function isAborted() {
      return iterator._isAborted;
    }), _defineProperty(_ref8, 'result', function result() {
      return iterator._result;
    }), _defineProperty(_ref8, 'error', function error() {
      return iterator._error;
    }), _defineEnumerableProperties(_ref8, _mutatorMap), _ref8;
  }
}