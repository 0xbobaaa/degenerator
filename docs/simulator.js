/*
 * The paper desk: the generated bot, run in a browser.
 *
 * It exists so the site can be played with rather than read. The desk holds a
 * copy of the risk.py that degenerator writes for the spec on the page, and
 * every order goes through it, so what the desk refuses is exactly what the
 * generated repository would refuse, down to the sentence.
 *
 * Nothing here is real. Prices are a seeded random walk, fills are invented at
 * the current tick, and no money or network is involved anywhere. The starting
 * price of each pair is the one the generated paper adapter quotes, so the
 * desk and the repository agree even about the fiction.
 *
 * tests/test_site_simulator.py runs the same orders through this file and
 * through the risk.py that the CLI actually writes, and fails if a single
 * decision or message differs.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./degenerator.js"));
  } else {
    root.Simulator = factory(root.Degenerator);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (D) {
  "use strict";

  var py = D.py;
  var encoder = new TextEncoder();

  // --- sha256, to quote the same placeholder price as the adapter ---------
  // crypto.subtle is async and the desk paints synchronously, so the hash is
  // here in full. It is the only reason this file knows any cryptography.

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function rotr(x, n) {
    return ((x >>> n) | (x << (32 - n))) >>> 0;
  }

  function sha256(bytes) {
    var h = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    var padded = new Uint8Array((((bytes.length + 9) >> 6) + 1) << 6);
    padded.set(bytes);
    padded[bytes.length] = 0x80;
    var view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor((bytes.length * 8) / 4294967296), false);
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0, false);

    var w = new Uint32Array(64);
    for (var offset = 0; offset < padded.length; offset += 64) {
      for (var i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
    }
    var out = new Uint8Array(32);
    var ov = new DataView(out.buffer);
    for (i = 0; i < 8; i++) ov.setUint32(i * 4, h[i], false);
    return out;
  }

  // src/venue/<venue>.py: placeholder_price(pair), to the digit.
  function placeholderPrice(pair) {
    var digest = sha256(encoder.encode(pair));
    var head = new DataView(digest.buffer).getUint32(0, false);
    return py.roundTo(10.0 + ((head % 100000) / 100.0), 2);
  }

  // --- src/risk.py, as generated for this spec ----------------------------

  function Risk(spec) {
    var spot = D.SPOT_ONLY.indexOf(spec.venue) !== -1;
    var MAX_POSITION = spec.max_position;
    var STOP_LOSS = spec.stop_loss;
    var LEVERAGE = spec.leverage;

    function maxNotional(equity) {
      return equity * MAX_POSITION.v * LEVERAGE.v;
    }

    function stopPrice(entry, side) {
      if (side === "long") return entry * (1.0 - STOP_LOSS.v);
      if (side === "short") return entry * (1.0 + STOP_LOSS.v);
      throw new Error("side must be 'long' or 'short', got " + JSON.stringify(side));
    }

    function check(order, equity) {
      var notional = order.notional;
      if (notional <= 0) return "notional must be positive, got " + py.reprFloat(notional);
      if (spot && order.side === "short") {
        return "short refused: " + spec.venue + " chain is spot only, there is nothing to borrow";
      }
      var cap = maxNotional(equity);
      if (notional > cap) {
        return (
          "notional " + py.fixed(notional, 2) + " over the cap " + py.fixed(cap, 2) +
          " (max_position " + py.numStr(MAX_POSITION) + ", leverage " + py.numStr(LEVERAGE) + ")"
        );
      }
      var asked = order.leverage === undefined || order.leverage === null ? LEVERAGE : order.leverage;
      if (asked.v > LEVERAGE.v) {
        return "leverage " + py.numStr(asked) + " over the cap " + py.numStr(LEVERAGE);
      }
      return null;
    }

    return {
      spot: spot,
      CASH: spec.cash,
      MAX_POSITION: MAX_POSITION,
      STOP_LOSS: STOP_LOSS,
      LEVERAGE: LEVERAGE,
      maxNotional: maxNotional,
      stopPrice: stopPrice,
      check: check,
    };
  }

  // --- the synthetic market -----------------------------------------------

  var HISTORY = 240;
  var FAST = 8;
  var SLOW = 21;

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // One synthetic market. A desk made on its own gets a tape of its own; the
  // site hands one tape to every bot, so BTC is the same BTC for all of them
  // and the only thing that differs between bots is the risk.py they carry.
  function tape(options) {
    options = options || {};
    var seed = options.seed === undefined ? 1 : options.seed >>> 0;
    return {
      synthetic: true,
      seed: seed,
      t: 0,
      volatility: options.volatility === undefined ? 0.006 : options.volatility,
      trend: options.trend === undefined ? 0 : options.trend,
      quotes: [],
      random: mulberry32(seed),
      spare: null,
    };
  }

  function quoteOn(tape, pair) {
    for (var i = 0; i < tape.quotes.length; i++) {
      if (tape.quotes[i].pair === pair) return tape.quotes[i];
    }
    var price = placeholderPrice(pair);
    var quote = { pair: pair, price: price, history: [price], shock: 0 };
    tape.quotes.push(quote);
    return quote;
  }

  function create(spec, options) {
    options = options || {};
    var shared = options.tape || null;
    var own = shared || tape(options);
    var desk = {
      synthetic: true,
      spec: spec,
      risk: Risk(spec),
      tape: own,
      shared: !!shared,
      autopilot: false,
      ask: options.ask || null,
      cash: spec.cash.v,
      realised: 0,
      halted: false,
      markets: spec.pairs.map(function (pair) { return quoteOn(own, pair); }),
      positions: {},
      log: [],
      serial: 0,
      counts:{ filled: 0, refused: 0, stopped: 0, closed: 0 },
    };
    // Read through to the tape, so a desk keeps the shape it always had.
    ["seed", "t", "volatility", "trend"].forEach(function (key) {
      Object.defineProperty(desk, key, {
        enumerable: true,
        get: function () { return own[key]; },
        set: function (value) { own[key] = value; },
      });
    });
    return desk;
  }

  function normal(tape) {
    if (tape.spare !== null) {
      var spare = tape.spare;
      tape.spare = null;
      return spare;
    }
    var u = 1 - tape.random();
    var v = tape.random();
    var radius = Math.sqrt(-2 * Math.log(u));
    tape.spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  }

  function market(desk, pair) {
    for (var i = 0; i < desk.markets.length; i++) {
      if (desk.markets[i].pair === pair) return desk.markets[i];
    }
    return null;
  }

  function unrealised(position, price) {
    var move = position.side === "long" ? price - position.entry : position.entry - price;
    return position.quantity * move;
  }

  function equity(desk) {
    var total = desk.cash + desk.realised;
    for (var pair in desk.positions) {
      if (Object.prototype.hasOwnProperty.call(desk.positions, pair)) {
        total += unrealised(desk.positions[pair], market(desk, pair).price);
      }
    }
    return total;
  }

  function note(desk, entry) {
    entry.t = desk.t;
    entry.n = ++desk.serial;
    if (Object.prototype.hasOwnProperty.call(desk.counts, entry.kind)) desk.counts[entry.kind] += 1;
    desk.log.push(entry);
    if (desk.log.length > 400) desk.log.shift();
    return entry;
  }

  function money(value) {
    return (value < 0 ? "" : "+") + py.fixed(value, 2);
  }

  function submit(desk, order) {
    if (desk.halted) {
      return note(desk, {
        kind: "refused", source: "desk", pair: order.pair,
        text: "the desk is halted: equity is gone, reset to start again",
      });
    }
    var open = desk.positions[order.pair];
    if (open) {
      return note(desk, {
        kind: "refused", source: "desk", pair: order.pair,
        text: "one position per pair on this desk: close " + order.pair + " first",
      });
    }
    var quote = market(desk, order.pair);
    if (!quote) {
      return note(desk, {
        kind: "refused", source: "desk", pair: order.pair,
        text: order.pair + " is not in this spec",
      });
    }

    var refusal = desk.risk.check(order, equity(desk));
    if (refusal !== null) {
      return note(desk, {
        kind: "refused", source: "risk.py", pair: order.pair, text: refusal, by: order.by || "you",
      });
    }

    var stop = desk.risk.stopPrice(quote.price, order.side);
    desk.positions[order.pair] = {
      pair: order.pair,
      side: order.side,
      notional: order.notional,
      entry: quote.price,
      quantity: order.notional / quote.price,
      stop: stop,
      openedAt: desk.t,
    };
    return note(desk, {
      kind: "filled", source: desk.risk.spot ? "swap" : "fill", pair: order.pair, by: order.by || "you",
      text: order.side + " " + order.pair + " " + py.fixed(order.notional, 2) +
        " at " + py.fixed(quote.price, 2) + ", stop " + py.fixed(stop, 2) +
        (desk.risk.spot ? " (model=swap)" : ""),
    });
  }

  function close(desk, pair, why) {
    var position = desk.positions[pair];
    if (!position) return null;
    var price = market(desk, pair).price;
    var gain = unrealised(position, price);
    desk.realised += gain;
    delete desk.positions[pair];
    var who = { stop: "risk.py", signal: "autopilot", halt: "desk" }[why] || "you";
    return note(desk, {
      kind: why === "stop" ? "stopped" : "closed", source: who, by: who, pair: pair,
      text: (why === "stop" ? "stop hit on " : "closed " + position.side + " ") + pair +
        " at " + py.fixed(price, 2) +
        (why === "stop" ? " (stop " + py.fixed(position.stop, 2) + ")" : "") +
        ", realised " + money(gain),
    });
  }

  function average(history, length) {
    if (history.length < length) return null;
    var total = 0;
    for (var i = history.length - length; i < history.length; i++) total += history[i];
    return total / length;
  }

  // The demo strategy sizes at the cap unless it was given an appetite of its
  // own, a share of equity it asks for without reading the spec. Then risk.py
  // gets the ask first, and a strategy that is told no comes back at the cap,
  // which is how a sizing bug meets a risk module in a real repository.
  function enter(desk, pair, side) {
    var cap = desk.risk.maxNotional(equity(desk));
    if (desk.ask) {
      var entry = submit(desk, { pair: pair, side: side, notional: equity(desk) * desk.ask, by: "autopilot" });
      if (entry.kind !== "refused" || entry.source !== "risk.py") return entry;
    }
    return submit(desk, { pair: pair, side: side, notional: cap, by: "autopilot" });
  }

  // A demo strategy, and only that: an 8 over 21 moving-average cross. It is
  // not the rules from the spec. degenerator never turns rule text into code,
  // and a page that pretended otherwise would be lying about the tool.
  function autopilot(desk) {
    desk.markets.forEach(function (quote) {
      var fast = average(quote.history, FAST);
      var slow = average(quote.history, SLOW);
      var previousFast = average(quote.history.slice(0, -1), FAST);
      var previousSlow = average(quote.history.slice(0, -1), SLOW);
      if (fast === null || slow === null || previousFast === null || previousSlow === null) return;

      var crossedUp = previousFast <= previousSlow && fast > slow;
      var crossedDown = previousFast >= previousSlow && fast < slow;
      var open = desk.positions[quote.pair];

      if (crossedUp) {
        if (open && open.side === "short") close(desk, quote.pair, "signal");
        if (!desk.positions[quote.pair]) enter(desk, quote.pair, "long");
      } else if (crossedDown) {
        if (open && open.side === "long") close(desk, quote.pair, "signal");
        // A spot chain has nothing to borrow, so the demo strategy stands
        // aside rather than sending an order risk.py would only refuse.
        if (!desk.risk.spot && !desk.positions[quote.pair]) enter(desk, quote.pair, "short");
      }
    });
  }

  // Moves every price on the tape by one step.
  function advance(tape) {
    tape.t += 1;
    tape.quotes.forEach(function (quote) {
      var z = normal(tape);
      var factor = Math.exp(tape.trend - (tape.volatility * tape.volatility) / 2 + tape.volatility * z);
      if (quote.shock) {
        factor *= 1 + quote.shock;
        quote.shock = 0;
      }
      quote.price = Math.max(quote.price * factor, 0.01);
      quote.history.push(quote.price);
      if (quote.history.length > HISTORY) quote.history.shift();
    });
    return tape;
  }

  // A desk on its own tape moves the market and then reacts to it. On a
  // shared tape the market is moved once by whoever owns it, and each desk
  // only reacts.
  function tick(desk) {
    if (desk.halted) return desk;
    if (!desk.shared) advance(desk.tape);
    return react(desk);
  }

  function react(desk) {
    if (desk.halted) return desk;

    desk.markets.forEach(function (quote) {
      var position = desk.positions[quote.pair];
      if (!position) return;
      var hit = position.side === "long" ? quote.price <= position.stop : quote.price >= position.stop;
      if (hit) close(desk, quote.pair, "stop");
    });

    if (desk.autopilot) autopilot(desk);

    if (equity(desk) <= 0) {
      Object.keys(desk.positions).forEach(function (pair) { close(desk, pair, "halt"); });
      desk.halted = true;
      note(desk, { kind: "halted", source: "desk", text: "equity is gone: the desk stops here" });
    }
    return desk;
  }

  function shock(desk, pair, percent) {
    var quote = market(desk, pair);
    if (!quote) return null;
    quote.shock = percent;
    return note(desk, {
      kind: "shock", source: "desk", pair: pair,
      text: "a " + py.fixed(percent * 100, 1) + "% jump is queued on " + pair + " for the next tick",
    });
  }

  // Everything the desk did, marked synthetic in the file itself, the way a
  // receipt marks what wrote it.
  function session(desk) {
    return {
      synthetic: true,
      note: "Synthetic prices, paper fills, no money and no network. Not a record of any market.",
      seed: desk.seed,
      ticks: desk.t,
      spec: {
        title: desk.spec.title,
        venue: desk.spec.venue,
        pairs: desk.spec.pairs.slice(),
        max_position: py.numStr(desk.spec.max_position),
        stop_loss: py.numStr(desk.spec.stop_loss),
        leverage: py.numStr(desk.spec.leverage),
        cash: py.numStr(desk.spec.cash),
      },
      equity: py.fixed(equity(desk), 2),
      realised: py.fixed(desk.realised, 2),
      positions: Object.keys(desk.positions).map(function (pair) {
        var position = desk.positions[pair];
        return {
          pair: pair,
          side: position.side,
          notional: py.fixed(position.notional, 2),
          entry: py.fixed(position.entry, 2),
          stop: py.fixed(position.stop, 2),
          unrealised: py.fixed(unrealised(position, market(desk, pair).price), 2),
        };
      }),
      log: desk.log.slice(),
    };
  }

  // A jump on a shared tape, felt by every desk that holds the pair.
  function jolt(tape, pair, percent) {
    quoteOn(tape, pair).shock = percent;
  }

  return {
    HISTORY: HISTORY,
    placeholderPrice: placeholderPrice,
    Risk: Risk,
    tape: tape,
    quote: quoteOn,
    create: create,
    advance: advance,
    react: react,
    jolt: jolt,
    tick: tick,
    submit: submit,
    close: close,
    shock: shock,
    equity: equity,
    unrealised: unrealised,
    session: session,
    money: money,
  };
});
