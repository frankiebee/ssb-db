'use strict'
var path = require('path')
var Flume = require('flumedb')
var codec = require('./codec')
var AsyncWrite = require('async-write')
var V = require('ssb-validate')
var timestamp = require('monotonic-timestamp')
var Obv = require('obv')
var u = require('./util')
var isFeed = require('ssb-ref').isFeed

/*
var Compat = require('flumelog-aligned-offset/compat')
var FlumeLogAligned = require('flumelog-aligned-offset')
function OffsetLog(file, opts) {
  return Compat(FlumeLogAligned(file, opts))
}
*/
var OffsetLog = require('flumelog-memory')
/*
  this file provides the flumelog,
  message append (and validation)
  and decrypting - as that is part of loading the messages.

*/

var isArray = Array.isArray
function isFunction (f) { return typeof f === 'function' }

/*
## queue (msg, cb)

add a message to the log, buffering the write to make it as fast as
possible, cb when the message is queued.

## append (msg, cb)

write a message, callback once it's definitely written.
*/

function isString (s) {
  return typeof s === 'string'
}

module.exports = function (dirname, keys, opts, map) {
  var ssbKeys = opts && opts.passwordProtected ? require('ssb-keys-password-protected')(opts.encrypt, opts.decrypt) : require('ssb-keys')
  var box = ssbKeys.box

  var hmacKey = opts && opts.caps && opts.caps.sign

  var log = OffsetLog(path.join(dirname, 'log.offset'), { blockSize: 1024 * 16, codec })

  // NOTE: must use db.ready.set(true) at when migration is complete
  // false says the database is not ready yet!
  var db = Flume(log, true, map)
    .use('last', require('./indexes/last')())

  var state = V.initial()
  var ready = false
  var waiting = []
  var flush = []

  var append = db.rawAppend = db.append
  db.post = Obv()
  var queue = AsyncWrite(function (_, cb) {
    var batch = state.queue
    state.queue = []
    append(batch, function (err, v) {
      batch.forEach(function (data) {
        db.post.set(u.originalData(data))
      })
      cb(err, v)
    })
  }, function reduce (_, msg) {
    return V.append(state, hmacKey, msg)
  }, function (_state) {
    return state.queue.length > 1000
  }, function isEmpty (_state) {
    return !state.queue.length
  }, 100)

  queue.onDrain = function () {
    if (state.queue.length === 0) {
      var l = flush.length
      for (var i = 0; i < l; ++i) { flush[i]() }
      flush = flush.slice(l)
    }
  }

  //load the map of the latest items, copy into validation state.
  db.last.get(function (_, last) {
    // copy to so we avoid weirdness, because this object
    // tracks the state coming in to the database.
    for (var k in last) {
      state.feeds[k] = {
        id: last[k].id,
        timestamp: last[k].ts || last[k].timestamp,
        sequence: last[k].sequence,
        queue: []
      }
    }
    ready = true

    var l = waiting.length
    for (var i = 0; i < l; ++i) { waiting[i]() }
    waiting = waiting.slice(l)
  })

  function wait (fn) {
    return function (value, cb) {
      if (ready) fn(value, cb)
      else {
        waiting.push(function () {
          fn(value, cb)
        })
      }
    }
  }

  db.queue = wait(function (msg, cb) {
    queue(msg, function (err) {
      var data = state.queue[state.queue.length - 1]
      if (err) cb(err)
      else cb(null, data)
    })
  })

  db.append = wait(function (opts, cb) {
    try {
      var content = opts.content
      var recps = opts.content.recps
      if (recps) {
        const isNonEmptyArrayOfFeeds = isArray(recps) && recps.every(isFeed) && recps.length > 0
        if (isFeed(recps) || isNonEmptyArrayOfFeeds) {
          recps = opts.content.recps = [].concat(recps) // force to array
          content = opts.content = box(opts.content, recps)
        } else {
          const errMsg = 'private message recipients must be valid, was:' + JSON.stringify(recps)
          throw new Error(errMsg)
        }
      }

      var msg = V.create(
        state.feeds[opts.keys.id],
        opts.keys, opts.hmacKey || hmacKey,
        content,
        timestamp()
      )
    } catch (err) {
      cb(err)
      return
    }

    queue(msg, function (err) {
      if (err) return cb(err)
      var data = state.queue[state.queue.length - 1]
      flush.push(function () {
        cb(null, data)
      })
    })
  })

  db.publish = function (content, cb) {
    return db.append({content: content, keys: keys}, cb)
  }

  db.buffer = function () {
    return queue.buffer
  }

  db.flush = function (cb) {
    // maybe need to check if there is anything currently writing?
    if (!queue.buffer || !queue.buffer.queue.length && !queue.writing) cb()
    else flush.push(cb)
  }

  return db
}



