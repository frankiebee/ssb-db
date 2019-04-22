'use strict'

var join = require('path').join
var EventEmitter = require('events')
//var ViewLevel = require('flumeview-level')
var ltgt = require('ltgt')

var pull = require('pull-stream')
var ref = require('ssb-ref')

var u = require('./util')

function isString (s) {
  return typeof s === 'string'
}

function errorCB (err) {
  if (err) throw err
}

module.exports = function (path, opts, keys) {
  var ssbKeys = opts.passwordProtected ? require('ssb-keys-password-protected')(opts) : require('ssb-keys')

  //_ was legacy db. removed that, but for backwards compatibilty reasons do not change interface
  if(!path) throw new Error('path must be provided')

  keys = keys || ssbKeys.generate()

  var db = require('./db')(join(opts.path || path, 'flume'), keys, opts)

  // UGLY HACK, but...
  // fairly sure that something up the stack expects ssb to be an event emitter.
  db.__proto__ = new EventEmitter() // eslint-disable-line

  db.opts = opts

  db.id = keys.id

  var _get = db.get

  db.get = function (key, cb) {
    let isPrivate = false
    let unbox
    let meta = false
    if (typeof key === 'object') {
      isPrivate = key.private === true
      unbox = key.unbox
      meta = key.meta
      key = key.id
    }

    if (ref.isMsg(key)) {
      return db.keys.get(key, function (err, data) {
        if (err) return cb(err)

        if (isPrivate && unbox) {
          data = db.unbox(data, unbox)
        }

        let result

        if (isPrivate) {
          result = data.value
        } else {
          result = u.originalValue(data.value)
        }

        cb(null, !meta ? result : {key: data.key, value: result, timestamp: data.timestamp})
      })
    } else if (ref.isMsgLink(key)) {
      var link = ref.parseLink(key)
      return db.get({
        id: link.link,
        private: true,
        unbox: link.query.unbox.replace(/\s/g, '+'),
        meta: link.query.meta
      }, cb)
    } else if (Number.isInteger(key)) {
      _get(key, cb) // seq
    } else {
      throw new Error('ssb-db.get: key *must* be a ssb message id or a flume offset')
    }
  }

  db.add = function (msg, cb) {
    db.queue(msg, function (err, data) {
      if (err) cb(err)
      else db.flush(function () { cb(null, data) })
    })
  }

  //would like to remove this, but loads of tests use it.
  db.createFeed = function (keys) {
    console.error('deprecated api used: db.createFeed, please use db.publish directly')
    if (!keys) keys = ssbKeys.generate()
    function add (content, cb) {
      // LEGACY: hacks to support add as a continuable
      if (!cb) { return function (cb) { add(content, cb) } }

      db.append({ content: content, keys: keys }, cb)
    }
    return {
      add: add,
      publish: add,
      id: keys.id,
      keys: keys
    }
  }

  db.createRawLogStream = function (opts) {
    opts = opts || {}
    var isPrivate = opts.private === true
    return pull(
      db.stream(opts),
      pull.map(function (data) {
        if (isPrivate) {
          return data
        } else {
          if(opts.seqs)
            return {
              seq: data.seq,
              value: {
                key: data.value.key,
                value: u.originalValue(data.value.value),
                timestamp: data.value.timestamp
              }
            }
          else
            return {
              key: data.key,
              value: u.originalValue(data.value),
              timestamp: data.timestamp
            }
        }
      })
    )
  }

  // called with [id, seq] or "<id>:<seq>" (used by ssb-edb replication)
  db.getAtSequence = function (seqid, cb) {
    // will NOT expose private plaintext
    const parts = isString(seqid) ? seqid.split(':') : seqid
    const id = parts[0], seq = parts[1]
    db.clock.get(function (err, state) {
      if(err) cb(err)
      else if(!state[id] || state[id][seq] == null)
        cb(new Error('not found: getAtSequence([' + id + ', '+seq+'])'))
      else
        db.get(state[id][seq], cb)
    })
  }

  db.getVectorClock = function (_, cb) {
    if (!cb) cb = _
    db.last.get(function (err, h) {
      if (err) return cb(err)
      var clock = {}
      for (var k in h) { clock[k] = h[k].sequence }
      cb(null, clock)
    })
  }

//  db
//    .use('time', ViewLevel(2, function (data) {
//      return [data.timestamp]
//    }))
//
  db.createLogStream = function (opts) {
    opts = u.options(opts)
    if (opts.raw) { return db.stream(opts) }

    var keys = opts.keys; delete opts.keys
    var values = opts.values; delete opts.values
    if (opts.gt == null) { opts.gt = 0 }

    return pull(
      //XXX not scalable, only usable for a proof of concept!
      //    a binary search would be better!
      db.stream({seqs: true, live: opts.live, reverse: opts.reverse}),
      pull.filter(function (data) {
        return ltgt.contains(opts, data.value.timestamp)
      }),
      u.Format(keys, values, opts.private)
    )
  }


  return db
}


