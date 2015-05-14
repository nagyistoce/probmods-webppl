////////////////////////////////////////////////////////////////////
// Lightweight MH

'use strict';

var _ = require('underscore');
var assert = require('assert');
var erp = require('../erp.js');
var diagnostics = require('./mh-diagnostics/diagnostics.js')

module.exports = function(env) {

  function gaussianProposalParams(params, prevVal) {
    var mu = prevVal;
    var sigma = params[1] * 0.7;
    return [mu, sigma];
  }

  function dirichletProposalParams(params, prevVal) {
    var concentration = 0.1; // TODO: choose the right parameters.
    var driftParams = params.map(function(x) {return concentration * x});
    return driftParams;
  }  

  var gaussianDriftERP = new erp.ERP(
    erp.gaussianERP.sample,
    erp.gaussianERP.score,
    {proposalParams: gaussianProposalParams});

  var dirichletDriftERP = new erp.ERP(
    erp.dirichletERP.sample,
    erp.dirichletERP.score,
    {proposalParams: dirichletProposalParams});

  function findChoice(trace, name) {
    if (trace === undefined) {
      return undefined;
    }
    for (var i = 0; i < trace.length; i++) {
      if (trace[i].name === name) {
        return trace[i];
      }
    }
    return undefined;
  }

  function acceptProb(trace, oldTrace, regenFrom, currScore, oldScore) {
    if ((oldTrace === undefined) || oldScore === -Infinity) {
      return 1;
    } // init
    var fw = -Math.log(oldTrace.length);
    trace.slice(regenFrom).map(function(s) {
      fw += s.forwardChoiceScore;
    });
    var bw = -Math.log(trace.length);
    oldTrace.slice(regenFrom).map(function(s) {
      var nc = findChoice(trace, s.name);
      if (nc){
        bw += s.reverseChoiceScore;
      }
    });
    var p = Math.exp(currScore - oldScore + bw - fw);
    assert.ok(!isNaN(p));
    var acceptance = Math.min(1, p);
    return acceptance;
  }

  function isDriftERP(erp) {
    return typeof erp.proposalParams === 'function';
  }

  function MH(s, k, a, wpplFn, numIterations, burn, diagnostics) {
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
    this.acceptedProposals = 0;
    this.rejectedProposals = 0;
    this.vals = [];
    this.diagnostics = typeof diagnostics !== 'undefined' ? diagnostics : false;
    this.burn = typeof burn !== 'undefined' ? burn : Math.min(500, Math.floor(numIterations / 2));
    // Move old coroutine out of the way and install this as the current
    // handler.

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

  MH.prototype.sample = function(s, cont, name, erp, params, forceSample) {
    var prev = findChoice(this.oldTrace, name);
    var val, forwardChoiceScore, reverseChoiceScore;

    if (prev === undefined) {
      // no previous value; sample from prior
      val = erp.sample(params);
      forwardChoiceScore = erp.score(params, val);
      reverseChoiceScore = 0;

    } else if (forceSample) {
      // sample from mh proposal distribution
      if (isDriftERP(erp)){
        // custom proposal distribution
        var proposalParams = erp.proposalParams(params, prev.val);
        val = erp.sample(proposalParams);
        forwardChoiceScore = erp.score(proposalParams, val);
        var nextProposalParams = erp.proposalParams(params, val);
        reverseChoiceScore = erp.score(nextProposalParams, prev.val);

      } else {
        // proposal distribution is prior
        val = erp.sample(params);
        forwardChoiceScore = erp.score(params, val);
        reverseChoiceScore = erp.score(params, prev.val)
      }

    } else {
      // reuse previous value
      val = prev.val;
      forwardChoiceScore = 0;
      reverseChoiceScore = 0;
    }

    this.trace.push({
      k: cont, name: name, erp: erp, params: params,
      score: this.currScore, forwardChoiceScore: forwardChoiceScore,
      reverseChoiceScore: reverseChoiceScore, val: val,
      store: _.clone(s)
    });
    this.currScore += erp.score(params, val);
    return cont(s, val);
  };


  MH.prototype.exit = function(s, val) {
    if (this.iterations > 0) {
      this.iterations -= 1;

      //did we like this proposal?
      var acceptance = acceptProb(this.trace, this.oldTrace,
          this.regenFrom, this.currScore, this.oldScore);
      if (Math.random() >= acceptance) {
        // if rejected, roll back trace, etc:
        this.rejectedProposals += 1;
        this.trace = this.oldTrace;
        this.currScore = this.oldScore;
        val = this.oldVal;
      } else {
        this.acceptedProposals += 1;
      }
      // now add val to hist:
      if (this.burn < this.rejectedProposals + this.acceptedProposals) {
        if (this.diagnostics) {
          this.vals.push(val);
        }
        var stringifiedVal = JSON.stringify(val);
        if (this.returnHist[stringifiedVal] === undefined) {
          this.returnHist[stringifiedVal] = {prob: 0, val: val};
        }
        this.returnHist[stringifiedVal].prob += 1;
      }
      // make a new proposal:
      this.regenFrom = Math.floor(Math.random() * this.trace.length);
      var regen = this.trace[this.regenFrom];
      this.oldTrace = this.trace;
      this.trace = this.trace.slice(0, this.regenFrom);
      this.oldScore = this.currScore;
      this.currScore = regen.score;
      this.oldVal = val;

      return this.sample(_.clone(regen.store), regen.k, regen.name, regen.erp, regen.params, true);
    } else {
      var dist = erp.makeMarginalERP(this.returnHist);

      // Reinstate previous coroutine:
      var k = this.k;
      env.coroutine = this.oldCoroutine;
      if (this.diagnostics) {
        var acceptanceRate = this.acceptedProposals / (this.acceptedProposals + this.rejectedProposals);
        console.log('Acceptance rate: ' + acceptanceRate);
        console.log('Number of samples: ' + this.vals.length);
        diagnostics.run(this.vals);
      }
      // Return by calling original continuation:
      return k(this.oldStore, dist);
    }
  };

  function mh(s, cc, a, wpplFn, numIterations, burn, diagnostics) {
    return new MH(s, cc, a, wpplFn, numIterations, burn, diagnostics).run();
  }

  return {
    MH: mh,
    findChoice: findChoice,
    acceptProb: acceptProb,
    gaussianDriftERP: gaussianDriftERP,
    dirichletDriftERP: dirichletDriftERP
  };
};
