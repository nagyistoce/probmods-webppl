////////////////////////////////////////////////////////////////////
// Lightweight MH

'use strict';

var _ = require('underscore');
var assert = require('assert');
var util = require('../util.js');
var erp = require('../erp.js');

module.exports = function(env) {

  function makeTrace(s, k, name, erp, params, currScore, choiceScore, val, reuse) {
    return {k: k, name: name, erp: erp, params: params, score: currScore,
            choiceScore: choiceScore, val: val, reused: reuse, store: s};
  }

  function findChoice(trace, name) {
    return _.findWhere(trace, {name: name});
  }

  function acceptProb(trace, oldTrace, regenFrom, currScore, oldScore) {
    if (oldTrace === undefined || oldScore === -Infinity) {return 1;} // init
    var fw = -Math.log(oldTrace.length);
    trace.slice(regenFrom).map(function(s) {
      fw += s.reused ? 0 : s.choiceScore;
    });
    var bw = -Math.log(trace.length);
    oldTrace.slice(regenFrom).map(function(s) {
      var nc = findChoice(trace, s.name);
      bw += (nc && nc.reused) ? 0 : s.choiceScore;
    });
    var p = Math.exp(currScore - oldScore + bw - fw);
    assert.ok(!isNaN(p));
    return Math.min(1, p);
  }

  function MH(s, k, a, wpplFn, numIterations) {
    this.trace = [];
    this.oldTrace = undefined;
    this.currScore = 0;
    this.oldScore = -Infinity;
    this.oldVal = undefined;
    this.regenFrom = 0;
    this.returnHist = {};
    this.k = k;
    this.oldStore = s;
    this.iterations = numIterations;

    // Move old coroutine out of the way and install this as current handler.
    this.wpplFn = wpplFn;
    this.s = s;
    this.a = a;
    this.oldCoroutine = env.coroutine;
    env.coroutine = this;
  }

  MH.prototype.run = function() {
    return this.wpplFn(this.s, env.exit, this.a);
  };

  MH.prototype.factor = function(s, k, a, score) {
    this.currScore += score;
    return k(s);
  };

  MH.prototype.sample = function(s, k, name, erp, params, forceSample) {
    var prev = findChoice(this.oldTrace, name);
    var reuse = !(prev === undefined || forceSample || !util.arrayEq(params, prev.params));
    var val = reuse ? prev.val : erp.sample(params);
    var choiceScore = erp.score(params, val);
    this.trace.push(makeTrace(_.clone(s), k, name, erp, params,
                              this.currScore, choiceScore, val, reuse));
    this.currScore += choiceScore;
    return k(s, val);
  };

  MH.prototype.propose = function(val) {
    this.regenFrom = Math.floor(Math.random() * this.trace.length);
    var regen = this.trace[this.regenFrom];
    this.oldTrace = this.trace;
    this.trace = this.trace.slice(0, this.regenFrom);
    this.oldScore = this.currScore;
    this.currScore = regen.score;
    this.oldVal = val;
    return this.sample(_.clone(regen.store), regen.k, regen.name, regen.erp, regen.params, true);
  };

  MH.prototype.exit = function(s, val) {
    if (this.iterations > 0) {
      this.iterations -= 1;
      // did we like this proposal?
      var acceptance = acceptProb(this.trace,
                                  this.oldTrace,
                                  this.regenFrom,
                                  this.currScore,
                                  this.oldScore);
      // if rejected, roll back trace, etc:
      if (Math.random() >= acceptance) {
        this.trace = this.oldTrace;
        this.currScore = this.oldScore;
        val = this.oldVal;
      }
      // now add val to hist:
      var stringifiedVal = JSON.stringify(val);
      if (this.returnHist[stringifiedVal] === undefined) {
        this.returnHist[stringifiedVal] = { prob: 0, val: val };
      }
      this.returnHist[stringifiedVal].prob += 1;
      return this.propose(val); // make a new proposal
    } else {
      var dist = erp.makeMarginalERP(this.returnHist);
      var k = this.k;
      env.coroutine = this.oldCoroutine; // Reinstate previous coroutine
      return k(this.oldStore, dist); // Return by calling original continuation
    }
  };

  function mh(s, cc, a, wpplFn, numParticles) {
    return new MH(s, cc, a, wpplFn, numParticles).run();
  }

  return {
    MH: mh,
    makeTrace: makeTrace,
    findChoice: findChoice,
    acceptProb: acceptProb
  };

};
