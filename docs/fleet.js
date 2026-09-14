/*
 * The fleet: every bot on the page, on one synthetic tape.
 *
 * The page opens mid-session. Five bots are built from the specs in the page,
 * each carrying the risk.py port from simulator.js for its own spec, and they
 * all read one tape, so the only thing that separates them is the file that
 * says no. Any of them can be taken over on the desk, and a spec written in
 * the build section joins them through the "degenerator:launch" event.
 *
 * Nothing here is real: synthetic prices, paper fills, no network.
 */
(function () {
  "use strict";

  var D = window.Degenerator;
  var S = window.Simulator;
  if (!D || !S) return;
  var py = D.py;

  var PRESETS = ["example-momentum", "preset-fullsend", "example-robinhood", "example-meanrevert", "preset-slow"];
  var ASK = 0.1;          // the demo strategy asks for 10% of equity, whatever the spec says
  var WARMUP = 160;       // ticks run before the first paint, so the page opens mid-session
  var MAX_CUSTOM = 3;
  var SPEEDS = [["1x", 700], ["4x", 175], ["16x", 45]];
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var state = {
    seed: 1,
    tape: null,
    bots: [],
    focus: null,
    pair: null,
    timer: null,
    interval: SPEEDS[0][1],
    pulse: [],
    feed: [],
    serial: 0,
    order: "",
  };
  var node = {};

  function $(id) { return document.getElementById(id); }

  function make(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function button(label, className, onClick) {
    var el = make("button", className, label);
    el.type = "button";
    el.addEventListener("click", onClick);
    return el;
  }

  function svg(tag, attrs) {
    var el = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs || {}).forEach(function (key) { el.setAttribute(key, attrs[key]); });
    return el;
  }

  function signed(value) { return (value < 0 ? "" : "+") + py.fixed(value, 2); }
  function percent(number) {
    var scaled = number.v * 100;
    return (Number.isInteger(scaled) ? String(scaled) : py.reprFloat(py.roundTo(scaled, 6))) + "%";
  }

  /* ---- bots ---------------------------------------------------------- */

  function botFrom(text, source, custom) {
    var spec = D.parse(text, source);
    var desk = S.create(spec, { tape: state.tape, ask: ASK });
    desk.autopilot = true;
    return { id: (custom ? "mine-" : "bot-") + spec.slug, spec: spec, text: text, source: source, custom: !!custom, desk: desk, seen: 0 };
  }

  function stats(bot) {
    var equity = S.equity(bot.desk);
    var start = bot.spec.cash.v;
    return { equity: equity, pnl: equity - start, pct: start ? (equity - start) / start : 0 };
  }

  function ranked() {
    return state.bots.slice().sort(function (a, b) {
      return stats(b).pct - stats(a).pct || (a.id < b.id ? -1 : 1);
    });
  }

  function boot(seed) {
    stop();
    state.seed = seed;
    var volatility = node.volatility ? Number(node.volatility.value) / 1000 : 0.006;
    var trend = node.trend ? Number(node.trend.value) / 20000 : 0;
    state.tape = S.tape({ seed: seed, volatility: volatility, trend: trend });
    var previous = state.bots;
    var focusId = state.focus && state.focus.id;
    state.bots = [];
    PRESETS.forEach(function (id) {
      var block = $(id);
      if (block) state.bots.push(botFrom(block.textContent, block.getAttribute("data-source"), false));
    });
    previous.filter(function (bot) { return bot.custom; }).forEach(function (bot) {
      state.bots.push(botFrom(bot.text, bot.source, true));
    });
    state.pulse = [];
    state.feed = [];
    state.order = "";
    $("bot-list").textContent = "";
    for (var i = 0; i < WARMUP; i++) advance();
    focus(state.bots.filter(function (b) { return b.id === focusId; })[0] || state.bots[0]);
    paint();
    if (!reduceMotion) run();
  }

  function advance() {
    S.advance(state.tape);
    var fills = 0, refusals = 0, total = 0;
    state.bots.forEach(function (bot) {
      S.react(bot.desk);
      collect(bot).forEach(function (entry) {
        total += 1;
        if (entry.kind === "filled") fills += 1;
        if (entry.kind === "refused" || entry.kind === "stopped" || entry.kind === "halted") refusals += 1;
      });
    });
    state.pulse.push({ total: total, fills: fills, refusals: refusals });
    if (state.pulse.length > 48) state.pulse.shift();
  }

  // New log entries from one bot, copied into the page-wide feed.
  function collect(bot) {
    var fresh = bot.desk.log.filter(function (entry) { return entry.n > bot.seen; });
    if (fresh.length) bot.seen = fresh[fresh.length - 1].n;
    fresh.forEach(function (entry) {
      state.feed.push({ bot: bot, entry: entry, serial: ++state.serial });
    });
    if (state.feed.length > 80) state.feed.splice(0, state.feed.length - 80);
    return fresh;
  }

  function note(text, kind) {
    state.feed.push({ bot: null, entry: { t: state.tape.t, kind: kind || "shock", source: "tape", text: text }, serial: ++state.serial });
  }

  /* ---- running ------------------------------------------------------- */

  function run() {
    if (state.timer) return;
    state.timer = setInterval(function () { advance(); paint(); }, state.interval);
    document.documentElement.classList.add("live");
    if (node.run) node.run.textContent = "pause";
  }

  function stop() {
    clearInterval(state.timer);
    state.timer = null;
    document.documentElement.classList.remove("live");
    if (node.run) node.run.textContent = "run";
  }

  function focus(bot) {
    if (!bot) return;
    state.focus = bot;
    if (bot.spec.pairs.indexOf(state.pair) === -1) state.pair = bot.spec.pairs[0];
    if (node.leverage) node.leverage.value = String(bot.spec.leverage.v);
    if (node.status) { node.status.textContent = ""; node.status.className = "status"; node.stamp.hidden = true; }
    buildDeskChips();
  }

  function takeWheel(bot) {
    focus(bot);
    paint();
    $("desk").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
  }

  function order(side) {
    var bot = state.focus;
    var cap = bot.desk.risk.maxNotional(S.equity(bot.desk));
    var asked = Number(node.leverage.value);
    var entry = S.submit(bot.desk, {
      pair: state.pair,
      side: side,
      notional: (cap * Number(node.size.value)) / 100,
      leverage: { v: asked, int: Number.isInteger(asked) },
      by: "you",
    });
    collect(bot);
    slip(entry.kind === "refused" ? "refused" : "filled", entry.source + ": " + entry.text, entry.kind);
    paint();
  }

  // The order slip gets a rubber stamp: red for a refusal, green for a fill.
  function slip(word, text, kind) {
    node.status.textContent = text;
    node.status.className = "status " + (kind || "");
    node.stamp.textContent = word;
    node.stamp.className = "bigstamp" + (word === "refused" ? "" : word === "closed" ? " ink" : " ok");
    node.stamp.hidden = false;
    void node.stamp.offsetWidth;
    node.stamp.className += " hit";
  }

  /* ---- layout -------------------------------------------------------- */

  function sheet(className) {
    var receipt = make("div", "receipt " + (className || ""));
    var paper = make("div", "paper");
    receipt.appendChild(paper);
    return { receipt: receipt, paper: paper };
  }

  function buildDesk() {
    var ui = $("desk-ui");

    var main = sheet("tilt-l");
    var head = make("div", "row");
    head.appendChild(make("span", "lbl", "bot"));
    node.botChips = make("span", "row");
    node.botChips.style.margin = "0";
    head.appendChild(node.botChips);
    main.paper.appendChild(head);

    var pairs = make("div", "row");
    pairs.appendChild(make("span", "lbl", "pair"));
    node.pairChips = make("span", "row");
    node.pairChips.style.margin = "0";
    pairs.appendChild(node.pairChips);
    node.price = make("span", "push");
    node.price.style.fontWeight = "800";
    pairs.appendChild(node.price);
    main.paper.appendChild(pairs);

    node.chart = svg("svg", { viewBox: "0 0 600 250", preserveAspectRatio: "none", class: "chart", role: "img", "aria-label": "Synthetic price of the selected pair" });
    main.paper.appendChild(node.chart);

    var legend = make("div", "row");
    legend.style.margin = "6px 0 12px";
    legend.appendChild(make("span", "dim", "synthetic · ○ fill · ● close · "));
    legend.appendChild(make("span", "neg", "● stop  - - stop line"));
    main.paper.appendChild(legend);

    var controls = make("div", "row");
    node.run = button("pause", "btn small", function () { if (state.timer) stop(); else run(); });
    controls.appendChild(node.run);
    controls.appendChild(button("step", "btn small", function () { stop(); advance(); paint(); }));
    node.speed = make("span", "row");
    node.speed.style.margin = "0";
    SPEEDS.forEach(function (speed, i) {
      var chip = button(speed[0], "chip", function () {
        state.interval = speed[1];
        Array.prototype.forEach.call(node.speed.children, function (other, j) { other.setAttribute("aria-pressed", String(i === j)); });
        if (state.timer) { stop(); run(); }
      });
      chip.setAttribute("aria-pressed", String(i === 0));
      node.speed.appendChild(chip);
    });
    controls.appendChild(node.speed);
    main.paper.appendChild(controls);

    var market = make("div", "row");
    node.volatility = range(0, 20, 1, 6, function () { state.tape.volatility = Number(node.volatility.value) / 1000; });
    market.appendChild(labelled("volatility", node.volatility));
    node.trend = range(-20, 20, 1, 0, function () { state.tape.trend = Number(node.trend.value) / 20000; });
    market.appendChild(labelled("trend", node.trend));
    market.appendChild(button("shock -10%", "btn small", function () {
      S.jolt(state.tape, state.pair, -0.1);
      note("a -10.0% jump is queued on " + state.pair + " for the next tick, for every bot that holds it");
      paint();
    }));
    market.appendChild(button("new market", "btn small", function () { boot(state.seed + 1); }));
    node.seed = make("span", "dim push");
    market.appendChild(node.seed);
    main.paper.appendChild(market);
    ui.appendChild(main.receipt);

    var side = sheet("tilt-r slip");
    side.paper.classList.add("slip");
    node.stamp = make("span", "bigstamp");
    node.stamp.hidden = true;
    node.stamp.setAttribute("aria-hidden", "true");
    side.paper.appendChild(node.stamp);
    var slipHead = make("div", "head");
    slipHead.appendChild(make("div", "big", "Order slip"));
    node.caps = make("div", "small");
    slipHead.appendChild(node.caps);
    side.paper.appendChild(slipHead);
    side.paper.appendChild(make("hr", "cut"));

    var ticket = make("div", "row");
    node.long = button("long", "btn small", function () { order("long"); });
    node.short = button("short", "btn small", function () { order("short"); });
    node.close = button("close", "btn small", function () {
      var bot = state.focus;
      if (bot.desk.positions[state.pair]) {
        var entry = S.close(bot.desk, state.pair, "you");
        collect(bot);
        slip("closed", "you: " + entry.text, "closed");
        paint();
      }
    });
    ticket.appendChild(node.long);
    ticket.appendChild(node.short);
    ticket.appendChild(node.close);
    side.paper.appendChild(ticket);

    var sizing = make("div", "row");
    node.size = range(10, 300, 5, 100, paint);
    sizing.appendChild(labelled("size", node.size));
    node.leverage = document.createElement("input");
    node.leverage.type = "number";
    node.leverage.min = "1";
    node.leverage.step = "1";
    sizing.appendChild(labelled("lev", node.leverage));
    node.auto = document.createElement("input");
    node.auto.type = "checkbox";
    node.auto.addEventListener("change", function () { state.focus.desk.autopilot = node.auto.checked; paint(); });
    sizing.appendChild(labelled("autopilot", node.auto));
    side.paper.appendChild(sizing);

    node.status = make("p", "status");
    node.status.setAttribute("aria-live", "polite");
    side.paper.appendChild(node.status);
    side.paper.appendChild(make("hr", "cut"));
    node.stats = make("dl", "lines");
    side.paper.appendChild(node.stats);
    node.ticketNote = make("p", "small-note");
    side.paper.appendChild(node.ticketNote);
    ui.appendChild(side.receipt);

    var journal = sheet();
    journal.receipt.style.gridColumn = "1 / -1";
    var logHead = make("div", "row");
    logHead.appendChild(make("span", "lbl", "receipts"));
    node.logMeta = make("span", "dim");
    logHead.appendChild(node.logMeta);
    logHead.appendChild(button("export session json", "btn small push", exportSession));
    journal.paper.appendChild(logHead);
    node.log = make("ul", "log");
    node.log.setAttribute("aria-label", "What this bot did");
    journal.paper.appendChild(node.log);
    ui.appendChild(journal.receipt);
  }

  function range(min, max, step, value, onInput) {
    var el = document.createElement("input");
    el.type = "range";
    el.min = min; el.max = max; el.step = step; el.value = value;
    el.addEventListener("input", onInput);
    return el;
  }

  function labelled(text, control) {
    var label = make("label");
    label.appendChild(make("span", null, text));
    label.appendChild(control);
    return label;
  }

  function buildDeskChips() {
    if (!node.botChips) return;
    node.botChips.textContent = "";
    state.bots.forEach(function (bot) {
      var chip = button(bot.spec.title, "chip", function () { focus(bot); paint(); });
      chip.setAttribute("aria-pressed", String(bot === state.focus));
      node.botChips.appendChild(chip);
    });
    node.pairChips.textContent = "";
    state.focus.spec.pairs.forEach(function (pair) {
      var chip = button(pair, "chip", function () {
        state.pair = pair;
        Array.prototype.forEach.call(node.pairChips.children, function (c) { c.setAttribute("aria-pressed", String(c.textContent === pair)); });
        paint();
      });
      chip.setAttribute("aria-pressed", String(pair === state.pair));
      node.pairChips.appendChild(chip);
    });
  }

  function exportSession() {
    var data = JSON.stringify(S.session(state.focus.desk), null, 2);
    var url = URL.createObjectURL(new Blob([data], { type: "application/json" }));
    var link = document.createElement("a");
    link.href = url;
    link.download = state.focus.spec.slug + "-session.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ---- painting ------------------------------------------------------ */

  function paint() {
    paintHero();
    paintRack();
    paintLeader();
    paintBots();
    paintDesk();
  }

  function sparkline(history, width, height) {
    var low = Math.min.apply(null, history), high = Math.max.apply(null, history);
    var span = high - low || 1;
    return history.map(function (price, i) {
      var x = history.length < 2 ? 0 : (i / (history.length - 1)) * width;
      var y = height - ((price - low) / span) * (height - 2) - 1;
      return x.toFixed(1) + "," + y.toFixed(1);
    }).join(" ");
  }

  function paintHero() {
    var t = state.tape;
    $("hero-status").textContent = (state.timer ? "rec" : "paused") + " · paper mode · synthetic tape · t " + t.t;
    $("tape-meta").textContent = t.quotes.length + " pairs · " + state.bots.length + " bots · one market";
    $("tape-state").textContent = "session " + t.seed + " · t " + t.t + (state.timer ? " · printing" : " · paused");

    var tiles = $("tiles");
    tiles.textContent = "";
    t.quotes.forEach(function (quote) {
      var first = quote.history[0];
      var change = first ? (quote.price - first) / first : 0;
      var li = make("li");
      li.appendChild(make("span", "pair", quote.pair));
      var spark = make("span", "spark");
      var chart = svg("svg", { viewBox: "0 0 100 16", preserveAspectRatio: "none", "aria-hidden": "true" });
      chart.appendChild(svg("polyline", { points: sparkline(quote.history.slice(-60), 100, 16) }));
      spark.appendChild(chart);
      li.appendChild(spark);
      li.appendChild(make("span", "px", py.fixed(quote.price, 2)));
      li.appendChild(make("span", "chg " + (change < 0 ? "neg" : ""), (change < 0 ? "" : "+") + py.fixed(change * 100, 1) + "%"));
      tiles.appendChild(li);
    });

    var feed = $("feed");
    feed.textContent = "";
    state.feed.slice(-8).reverse().forEach(function (item) {
      var li = make("li", item.entry.kind);
      li.appendChild(make("span", "t", "t" + item.entry.t));
      li.appendChild(make("span", "who", item.bot ? item.bot.spec.title : "tape"));
      if (item.entry.kind === "refused") li.appendChild(make("span", "stamp", "refused"));
      if (item.entry.kind === "stopped") li.appendChild(make("span", "stamp", "stop"));
      if (item.entry.kind === "refused" || item.entry.kind === "stopped") li.appendChild(document.createTextNode(" "));
      li.appendChild(make("span", "what", item.entry.source + ": " + item.entry.text));
      feed.appendChild(li);
    });
  }

  function totals() {
    var sum = { filled: 0, refused: 0, stopped: 0, pnl: 0 };
    state.bots.forEach(function (bot) {
      sum.filled += bot.desk.counts.filled;
      sum.refused += bot.desk.counts.refused;
      sum.stopped += bot.desk.counts.stopped;
      sum.pnl += stats(bot).pnl;
    });
    return sum;
  }

  function paintRack() {
    var sum = totals();
    $("st-bots").textContent = String(state.bots.length);
    $("st-fills").textContent = String(sum.filled);
    $("st-refused").textContent = String(sum.refused);
    $("st-stops").textContent = String(sum.stopped);
    $("st-tick").textContent = String(state.tape.t);
    var pnl = $("st-pnl");
    pnl.textContent = signed(sum.pnl);
    pnl.className = sum.pnl < 0 ? "neg" : "pos";

    var bars = $("pulse");
    bars.textContent = "";
    var peak = Math.max.apply(null, state.pulse.map(function (p) { return p.total; }).concat([1]));
    for (var i = 0; i < 48; i++) {
      var p = state.pulse[i - (48 - state.pulse.length)];
      var bar = make("i", p && p.refusals ? "hot" : p && p.fills ? "fill" : "");
      bar.style.height = (p ? Math.max(5, (p.total / peak) * 100) : 5) + "%";
      bars.appendChild(bar);
    }
  }

  function riskLine(spec) {
    return spec.venue + " · " + spec.pairs.join(" ") + " · max " + percent(spec.max_position) +
      " × " + py.numStr(spec.leverage) + "x · stop " + percent(spec.stop_loss);
  }

  function lastWord(bot) {
    var log = bot.desk.log;
    return log.length ? log[log.length - 1] : null;
  }

  function pctText(s) {
    return (s.pct < 0 ? "" : "+") + py.fixed(s.pct * 100, 2) + "%";
  }

  function paintLeader() {
    var bot = ranked()[0];
    if (!bot) return;
    var s = stats(bot);
    var mark = $("leader-pnl");
    mark.textContent = pctText(s);
    mark.className = "pct " + (s.pct < 0 ? "neg" : "pos");
    $("leader-name").textContent = bot.spec.title;
    $("leader-copy").textContent =
      "Equity " + py.fixed(s.equity, 2) + " from " + py.numStr(bot.spec.cash) + ", after " +
      bot.desk.counts.filled + " fills, " + bot.desk.counts.stopped + " stops and " +
      bot.desk.counts.refused + " orders its risk.py turned down.";
    $("leader-who").textContent = riskLine(bot.spec);
    $("leader-meta").textContent = "t " + state.tape.t + " · resets on reload";
    state.leader = bot;
  }

  function paintBots() {
    var list = $("bot-list");
    var bots = ranked();
    var best = Math.max.apply(null, bots.map(function (b) { return Math.abs(stats(b).pct); }).concat([0.0001]));
    var order = bots.map(function (b) { return b.id; }).join("|");
    if (order !== state.order) {
      state.order = order;
      bots.forEach(function (bot) { list.appendChild(card(bot)); });
    }
    bots.forEach(function (bot, i) {
      var li = card(bot);
      var s = stats(bot);
      var el = bot.els;
      el.rank.textContent = "No. " + (i < 9 ? "0" : "") + (i + 1);
      el.tick.textContent = "t " + state.tape.t;
      el.pct.textContent = pctText(s);
      el.pct.className = "pct " + (s.pct < 0 ? "neg" : "pos");
      var on = Math.round((Math.abs(s.pct) / best) * 12);
      el.meter.textContent = new Array(on + 1).join("█") + new Array(12 - on + 1).join("░");
      el.meter.className = "meter " + (s.pct < 0 ? "neg" : "");
      el.equity.textContent = py.fixed(s.equity, 2);
      el.fills.textContent = String(bot.desk.counts.filled);
      el.refused.textContent = String(bot.desk.counts.refused);
      el.refused.className = bot.desk.counts.refused ? "neg" : "";
      el.stops.textContent = String(bot.desk.counts.stopped);
      el.halt.hidden = !bot.desk.halted;
      var last = lastWord(bot);
      el.last.className = "last " + (last ? last.kind : "");
      el.last.textContent = last ? "t" + last.t + " " + last.source + ": " + last.text : "waiting for a signal";
    });
  }

  function card(bot) {
    if (bot.row) return bot.row;
    var el = {};
    var li = make("li");
    var sheetEl = sheet();
    var paper = sheetEl.paper;

    var no = make("div", "no");
    el.rank = make("span");
    el.tick = make("span");
    no.appendChild(el.rank);
    no.appendChild(el.tick);
    paper.appendChild(no);

    var name = button(bot.spec.title, "botname", function () { takeWheel(bot); });
    name.setAttribute("aria-label", "Take the wheel of " + bot.spec.title);
    paper.appendChild(name);
    paper.appendChild(make("div", "dim", riskLine(bot.spec)));

    var tags = make("div", "tags");
    if (bot.desk.risk.spot) tags.appendChild(make("span", "stamp ink", "spot only"));
    if (bot.custom) tags.appendChild(make("span", "stamp ok", "yours"));
    el.halt = make("span", "stamp", "halted");
    el.halt.hidden = true;
    tags.appendChild(el.halt);
    paper.appendChild(tags);

    paper.appendChild(make("hr", "cut"));
    el.pct = make("div", "pct");
    paper.appendChild(el.pct);
    el.meter = make("div", "meter");
    el.meter.setAttribute("aria-hidden", "true");
    paper.appendChild(el.meter);

    var lines = make("dl", "lines");
    [["equity", "equity"], ["fills", "fills"], ["refused by risk.py", "refused"], ["stops hit", "stops"]].forEach(function (pair) {
      var row = make("div");
      row.appendChild(make("dt", null, pair[0]));
      el[pair[1]] = make("dd", pair[1] === "refused" ? "neg" : null);
      row.appendChild(el[pair[1]]);
      lines.appendChild(row);
    });
    paper.appendChild(lines);

    el.last = make("p", "last");
    paper.appendChild(el.last);

    var foot = make("div", "foot");
    foot.appendChild(make("span", "dim", "paper · synthetic"));
    foot.appendChild(button("take the wheel", "btn small", function () { takeWheel(bot); }));
    paper.appendChild(foot);

    li.appendChild(sheetEl.receipt);
    bot.els = el;
    bot.row = li;
    return li;
  }

  function paintDesk() {
    var bot = state.focus;
    if (!bot || !node.chart) return;
    var desk = bot.desk;
    var equity = S.equity(desk);
    var cap = desk.risk.maxNotional(equity);
    var quote = S.quote(state.tape, state.pair);
    var position = desk.positions[state.pair];

    $("desk-meta").textContent = "driving: " + bot.spec.title + " · " + riskLine(bot.spec);
    Array.prototype.forEach.call(node.botChips.children, function (chip) {
      chip.setAttribute("aria-pressed", String(chip.textContent === bot.spec.title));
    });
    node.price.textContent = state.pair + " " + py.fixed(quote.price, 2);
    node.seed.textContent = "session " + state.tape.seed + " · t " + state.tape.t;
    node.caps.textContent = bot.spec.title + " · cap " + py.fixed(cap, 2) + " · stop " + percent(bot.spec.stop_loss) + " · " + py.numStr(bot.spec.leverage) + "x";
    node.auto.checked = desk.autopilot;
    node.close.disabled = !position;
    node.long.disabled = !!position || desk.halted;
    node.short.disabled = !!position || desk.halted;

    drawChart(bot, quote, position);

    node.stats.textContent = "";
    var open = 0;
    Object.keys(desk.positions).forEach(function (pair) { open += S.unrealised(desk.positions[pair], S.quote(state.tape, pair).price); });
    [
      ["equity", py.fixed(equity, 2)],
      ["realised", signed(desk.realised)],
      ["open pnl", signed(open)],
      ["order size", py.fixed((cap * Number(node.size.value)) / 100, 2) + " (" + node.size.value + "% of cap)"],
      ["position", position
        ? position.side + " " + py.fixed(position.notional, 2) + " @ " + py.fixed(position.entry, 2)
        : "flat"],
      ["stop", position ? py.fixed(position.stop, 2) : "—"],
    ].forEach(function (pair) {
      var row = make("div");
      row.appendChild(make("dt", null, pair[0]));
      row.appendChild(make("dd", null, pair[1]));
      node.stats.appendChild(row);
    });

    node.ticketNote.textContent =
      "Every order goes through the risk.py this spec generates, and so does the stop. " +
      "Push the size past 100% or the leverage past the spec to get it stamped" +
      (desk.risk.spot ? ", or try a short: this is a spot chain." : ".") +
      (position ? " Close the open position to place a new one." : "");

    node.logMeta.textContent = desk.counts.filled + " fills · " + desk.counts.refused + " refused · " + desk.counts.stopped + " stops";
    node.log.textContent = "";
    desk.log.slice(-60).reverse().forEach(function (entry) {
      var li = make("li", entry.kind);
      li.appendChild(make("span", "dim", "t" + entry.t));
      var src = entry.by && entry.by !== entry.source ? entry.by + " → " + entry.source : entry.source;
      li.appendChild(make("span", "src", src));
      li.appendChild(make("span", "txt", entry.text));
      node.log.appendChild(li);
    });
  }

  function drawChart(bot, quote, position) {
    var W = 600, H = 250;
    var history = quote.history.slice(-160);
    var low = Math.min.apply(null, history), high = Math.max.apply(null, history);
    if (position) {
      low = Math.min(low, position.stop, position.entry);
      high = Math.max(high, position.stop, position.entry);
    }
    var span = high - low || high || 1;
    low -= span * 0.1;
    high += span * 0.1;
    var y = function (price) { return H - ((price - low) / (high - low)) * H; };
    var x = function (i) { return history.length < 2 ? 0 : (i / (history.length - 1)) * W; };

    var chart = node.chart;
    chart.textContent = "";
    for (var g = 1; g < 5; g++) chart.appendChild(svg("line", { x1: 0, x2: W, y1: (H / 5) * g, y2: (H / 5) * g, class: "gridline" }));
    chart.appendChild(svg("polyline", {
      class: "price",
      points: history.map(function (p, i) { return x(i).toFixed(1) + "," + y(p).toFixed(1); }).join(" "),
    }));
    if (position) {
      chart.appendChild(svg("line", { x1: 0, x2: W, y1: y(position.entry), y2: y(position.entry), class: "entry" }));
      chart.appendChild(svg("line", { x1: 0, x2: W, y1: y(position.stop), y2: y(position.stop), class: "stop" }));
    }
    var now = state.tape.t;
    bot.desk.log.forEach(function (entry) {
      if (entry.pair !== quote.pair || ["filled", "stopped", "closed"].indexOf(entry.kind) === -1) return;
      var i = history.length - 1 - (now - entry.t);
      if (i < 0) return;
      chart.appendChild(svg("circle", { cx: x(i), cy: y(history[i]), r: 3.5, class: "dot-" + entry.kind }));
    });
  }

  /* ---- a bot written on the page ------------------------------------- */

  document.addEventListener("degenerator:launch", function (event) {
    var detail = event.detail;
    if (!detail) return;
    var bot;
    try {
      bot = botFrom(detail.text, detail.source, true);
    } catch (err) {
      return;
    }
    // A later run of the same spec replaces the earlier one.
    state.bots = state.bots.filter(function (other) {
      if (other.custom && other.spec.slug === bot.spec.slug) {
        if (other.row && other.row.parentNode) other.row.parentNode.removeChild(other.row);
        return false;
      }
      return true;
    });
    var mine = state.bots.filter(function (other) { return other.custom; });
    if (mine.length >= MAX_CUSTOM) {
      var oldest = mine[0];
      if (oldest.row && oldest.row.parentNode) oldest.row.parentNode.removeChild(oldest.row);
      state.bots.splice(state.bots.indexOf(oldest), 1);
    }
    state.bots.push(bot);
    state.order = "";
    note(bot.spec.title + " joined the tape with its own risk.py", "filled");
    takeWheel(bot);
    if (!state.timer && !reduceMotion) run();
  });

  /* ---- start --------------------------------------------------------- */

  buildDesk();
  ["tiles", "tiles-cut", "feed", "rack", "leader", "bot-list", "desk-ui"].forEach(function (id) { $(id).hidden = false; });
  ["console-nojs", "bots-nojs", "desk-nojs"].forEach(function (id) { $(id).hidden = true; });
  $("leader-take").addEventListener("click", function () { if (state.leader) takeWheel(state.leader); });
  if (reduceMotion) $("console-foot").textContent = "paused: your system asks for reduced motion · press run on the desk";
  window.DegeneratorFleet = { launched: function () { return state.bots.length; } };
  boot(1);
})();
