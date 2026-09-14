/*
 * The build section: degenerator itself, running in the tab.
 *
 * degenerator.js is the CLI's parser and templates, ported and checked against
 * the Python byte for byte in CI. Edit the spec and the repository rebuilds;
 * "put it on the tape" hands the spec to fleet.js, which starts a bot with the
 * risk.py that spec generates. If a script failed to load, the static spec and
 * tree in the HTML stay as they are.
 */
(function () {
  "use strict";

  function flash(button, word) {
    var was = button.getAttribute("data-label") || button.textContent;
    button.setAttribute("data-label", was);
    button.textContent = word;
    setTimeout(function () { button.textContent = was; }, 1000);
  }

  function copy(text, button) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { flash(button, "copied"); },
        function () { flash(button, "press ctrl+c"); }
      );
    } else {
      flash(button, "press ctrl+c");
    }
  }

  var caButton = document.querySelector("[data-copy-target]");
  if (caButton) {
    caButton.addEventListener("click", function () {
      var target = document.getElementById(caButton.getAttribute("data-copy-target"));
      if (target && !caButton.disabled) copy(target.textContent.trim(), caButton);
    });
  }

  var D = window.Degenerator;
  var app = document.getElementById("app");
  if (!D || !app) return;

  function $(id) { return document.getElementById(id); }
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var specName = $("spec-name");
  var examples = $("examples");
  var treeHead = $("tree-head");
  var outSize = $("out-size");
  var viewer = $("viewer");
  var viewerName = $("viewer-name");
  var viewerBody = $("viewer-body");
  var copyFile = $("copy-file");
  var download = $("download");
  var launch = $("launch");
  var next = $("next");

  var editor = document.createElement("textarea");
  editor.value = $("spec-source").textContent;
  editor.rows = 17;
  editor.setAttribute("spellcheck", "false");
  editor.setAttribute("autocapitalize", "off");
  editor.setAttribute("autocomplete", "off");
  editor.setAttribute("wrap", "off");
  editor.setAttribute("aria-label", "Spec. Edit it and the generated repository updates.");
  $("spec-source").replaceWith(editor);

  var files = document.createElement("ul");
  files.className = "files";
  files.setAttribute("aria-label", "Generated files");
  $("tree").replaceWith(files);

  var state = { source: "momentum.spec.md", selected: "src/risk.py", spec: null, files: [] };

  /* ---- examples and the "try it" buttons on refusals ----------------- */

  function load(text, source) {
    editor.value = text;
    state.source = source;
    specName.textContent = source;
    Array.prototype.forEach.call(examples.querySelectorAll(".chip"), function (chip) {
      chip.setAttribute("aria-pressed", String(chip.getAttribute("data-source") === source));
    });
    render();
  }

  examples.style.display = "flex";
  examples.style.flexWrap = "wrap";
  examples.style.gap = "4px";
  Array.prototype.forEach.call(document.querySelectorAll('script[id^="example-"], script[id^="preset-"]'), function (block) {
    var source = block.getAttribute("data-source");
    var chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = source.replace(/\.spec\.md$/, "");
    chip.setAttribute("data-source", source);
    chip.setAttribute("aria-pressed", String(source === state.source));
    chip.addEventListener("click", function () { load(block.textContent, source); });
    examples.appendChild(chip);
  });

  var refusalItems = document.querySelectorAll(".refusals li");
  Array.prototype.forEach.call(document.querySelectorAll('script[id^="refusal-"]'), function (block, i) {
    var item = refusalItems[i];
    if (!item) return;
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn small";
    button.textContent = "try it";
    button.addEventListener("click", function () {
      load(block.textContent, block.getAttribute("data-source"));
      app.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      editor.focus({ preventScroll: true });
    });
    item.appendChild(button);
  });

  /* ---- rendering ----------------------------------------------------- */

  var BRANCH = "├── ", LAST = "└── ", PIPE = "│   ", GAP = "    ";

  function tree(paths, dirs) {
    var root = new Map();
    function add(parts, path) {
      var level = root;
      parts.forEach(function (part, i) {
        if (!level.has(part)) level.set(part, { children: new Map(), path: null });
        var node = level.get(part);
        if (i === parts.length - 1) node.path = path;
        level = node.children;
      });
    }
    paths.forEach(function (path) { add(path.split("/"), path); });
    dirs.forEach(function (dir) { add([dir], null); });

    var rows = [];
    (function walk(level, prefix) {
      var names = Array.from(level.keys());
      names.forEach(function (name, i) {
        var node = level.get(name);
        var last = i === names.length - 1;
        rows.push({ glyph: prefix + (last ? LAST : BRANCH), name: name + (node.path === null ? "/" : ""), path: node.path });
        if (node.children.size) walk(node.children, prefix + (last ? GAP : PIPE));
      });
    })(root, "");
    return rows;
  }

  function row(entry) {
    var li = document.createElement("li");
    var el = document.createElement(entry.path ? "button" : "span");
    el.className = entry.path ? "" : "row";
    var glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = entry.glyph;
    el.appendChild(glyph);
    el.appendChild(document.createTextNode(entry.name));
    if (entry.path) {
      el.type = "button";
      el.setAttribute("data-path", entry.path);
      if (entry.path === state.selected) el.setAttribute("aria-current", "true");
      el.addEventListener("click", function () { select(entry.path); });
    }
    li.appendChild(el);
    return li;
  }

  function select(path) {
    var file = state.files.filter(function (f) { return f[0] === path; })[0];
    if (!file) return;
    state.selected = path;
    viewerName.textContent = path;
    viewerBody.textContent = file[1];
    Array.prototype.forEach.call(files.querySelectorAll("button"), function (b) {
      if (b.getAttribute("data-path") === path) b.setAttribute("aria-current", "true");
      else b.removeAttribute("aria-current");
    });
  }

  function refuse(message) {
    state.spec = null;
    state.files = [];
    treeHead.textContent = "refused";
    treeHead.className = "title refusal";
    outSize.textContent = "exit 2";
    files.textContent = "";
    var li = document.createElement("li");
    var text = document.createElement("span");
    text.className = "row refusal";
    text.textContent = "degenerator: " + message + "\n\nnothing is written when a spec is refused.";
    li.appendChild(text);
    files.appendChild(li);
    viewer.hidden = true;
    next.hidden = true;
    download.disabled = true;
    launch.disabled = true;
  }

  function render() {
    var spec;
    try {
      spec = D.parse(editor.value, state.source);
    } catch (err) {
      if (err instanceof D.SpecError) return refuse(err.message);
      throw err;
    }
    state.spec = spec;
    state.files = D.render(spec);
    var paths = state.files.map(function (f) { return f[0]; });

    if (paths.indexOf(state.selected) === -1) {
      var venueFile = /^src\/venue\/(?!base\.py$)/.test(state.selected);
      state.selected = venueFile ? "src/venue/" + spec.venue + ".py" : "src/risk.py";
    }

    treeHead.textContent = spec.slug + "/";
    treeHead.className = "title";
    outSize.textContent = state.files.length + " files · " + D.size(state.files).label;
    files.textContent = "";
    tree(paths, D.DIRECTORIES).forEach(function (entry) { files.appendChild(row(entry)); });
    select(state.selected);

    viewer.hidden = false;
    download.disabled = false;
    launch.disabled = !window.DegeneratorFleet;
    download.textContent = "download " + spec.slug + ".zip";
    next.textContent = "$ unzip " + spec.slug + ".zip && cd " + spec.slug + " && make test";
    next.hidden = false;
  }

  copyFile.addEventListener("click", function () {
    var file = state.files.filter(function (f) { return f[0] === state.selected; })[0];
    if (file) copy(file[1], copyFile);
  });

  download.addEventListener("click", function () {
    if (!state.spec) return;
    var url = URL.createObjectURL(new Blob([D.bundle(state.spec)], { type: "application/zip" }));
    var link = document.createElement("a");
    link.href = url;
    link.download = state.spec.slug + ".zip";
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  launch.addEventListener("click", function () {
    if (!state.spec) return;
    document.dispatchEvent(new CustomEvent("degenerator:launch", { detail: { text: editor.value, source: state.source } }));
  });

  editor.addEventListener("input", render);
  render();
})();
