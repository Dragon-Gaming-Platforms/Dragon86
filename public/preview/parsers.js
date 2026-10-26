/*
 * Preview parsers — pure functions, no DOM, no WebGL.
 *
 * Kept separate from app.js so they can be tested in Node against real files
 * (tools/test-preview.mjs) without a browser. Each returns plain arrays that
 * the renderer uploads to WebGL:
 *
 *   { kind: "mesh", positions: Float32Array, triangles, meshes, warning? }
 *   { kind: "iso", label, entries: [{ name, path, isDir, size, depth }] }
 *
 * Everything is flat-shaded triangles: no index buffers, no smoothing
 * groups, no materials. A preview shows you the shape; it is not a CAD app.
 */
(function (root) {
  "use strict";

  var MAX_TRIANGLES = 400000;

  function fail(message) {
    throw new Error(message);
  }

  /* ---------- helpers ---------- */

  function expand(indices, positions) {
    var out = new Float32Array(indices.length * 3);
    for (var i = 0; i < indices.length; i++) {
      var v = indices[i] * 3;
      out[i * 3] = positions[v];
      out[i * 3 + 1] = positions[v + 1];
      out[i * 3 + 2] = positions[v + 2];
    }
    return out;
  }

  function bounds(positions) {
    if (!positions.length) return null;
    var min = [Infinity, Infinity, Infinity];
    var max = [-Infinity, -Infinity, -Infinity];
    for (var i = 0; i < positions.length; i += 3) {
      for (var a = 0; a < 3; a++) {
        var v = positions[i + a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    return { min: min, max: max };
  }

  function mesh(positions, extra) {
    var b = bounds(positions);
    var result = {
      kind: "mesh",
      positions: positions,
      triangles: positions.length / 9,
      meshes: (extra && extra.meshes) || 1,
      bounds: b,
      warning: (extra && extra.warning) || "",
    };
    return result;
  }

  /* ---------- STL (binary and ASCII) ---------- */

  function parseSTL(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < 84) fail("STL is too short to be a file");

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var count = view.getUint32(80, true);
    /* A binary STL declares its triangle count; if that matches the file
       length exactly it is binary, otherwise look for the ASCII keyword. */
    var looksBinary = count > 0 && 84 + count * 50 <= bytes.byteLength;
    if (!looksBinary) {
      var head = "";
      for (var h = 0; h < Math.min(512, bytes.byteLength); h++) head += String.fromCharCode(bytes[h]);
      if (!/^\s*solid/i.test(head)) fail("this is neither a binary nor an ASCII STL");

      var text = decodeText(bytes);
      var verts = [];
      var re = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
      var m;
      while ((m = re.exec(text))) {
        verts.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
        if (verts.length / 9 >= MAX_TRIANGLES) break;
      }
      if (!verts.length) fail("ASCII STL has no triangles");
      return mesh(new Float32Array(verts));
    }

    count = Math.min(count, MAX_TRIANGLES);
    var out = new Float32Array(count * 9);
    var offset = 84;
    for (var i = 0; i < count; i++) {
      /* 12 bytes of normal, then three vertices of 12 bytes, then 2 bytes. */
      var p = offset + 12;
      for (var v = 0; v < 9; v++) {
        out[i * 9 + v] = view.getFloat32(p + v * 4, true);
      }
      offset += 50;
    }
    return mesh(out);
  }

  /* ---------- OBJ ---------- */

  function parseOBJ(text) {
    var positions = [];
    var tris = [];
    var lines = text.split(/\r?\n/);
    var hasFaces = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line || line.charAt(0) === "#") continue;
      var parts = line.split(/\s+/);
      if (parts[0] === "v") {
        positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
      } else if (parts[0] === "f") {
        hasFaces = true;
        var idx = [];
        for (var p = 1; p < parts.length; p++) {
          var raw = parts[p].split("/")[0];
          var n = parseInt(raw, 10);
          if (isNaN(n) || n === 0) continue;
          idx.push(n < 0 ? positions.length / 3 + n : n - 1);
        }
        /* Fan-triangulate n-gons, which is what OBJ faces usually are. */
        for (var t = 2; t < idx.length; t++) tris.push(idx[0], idx[t - 1], idx[t]);
      }
    }
    if (!positions.length) fail("OBJ has no vertices");
    if (!hasFaces) {
      /* Point clouds are legal OBJ; show nothing rather than crash. */
      return mesh(new Float32Array(0), { warning: "This OBJ has vertices but no faces — nothing to draw." });
    }
    if (tris.length / 3 > MAX_TRIANGLES) tris = tris.slice(0, MAX_TRIANGLES * 3);
    var pos = new Float32Array(positions);
    var bad = tris.some(function (n) { return n < 0 || n >= pos.length / 3; });
    if (bad) fail("OBJ refers to vertices it does not define");
    return mesh(expand(tris, pos));
  }

  /* ---------- PLY (ASCII and binary little-endian) ---------- */

  var PLY_SIZE = {
    char: 1, uchar: 1, int8: 1, uint8: 1,
    short: 2, ushort: 2, int16: 2, uint16: 2,
    int: 4, uint: 4, int32: 4, uint32: 4,
    float: 4, float32: 4, double: 8, float64: 8,
  };
  var PLY_GET = {
    char: "getInt8", uchar: "getUint8", int8: "getInt8", uint8: "getUint8",
    short: "getInt16", ushort: "getUint16", int16: "getInt16", uint16: "getUint16",
    int: "getInt32", uint: "getUint32", int32: "getInt32", uint32: "getUint32",
    float: "getFloat32", float32: "getFloat32", double: "getFloat64", float64: "getFloat64",
  };

  function parsePLY(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    var head = "";
    var i = 0;
    while (i < bytes.length) {
      head += String.fromCharCode(bytes[i++]);
      if (head.slice(-10) === "end_header") break;
    }
    var at = head.indexOf("end_header");
    if (at === -1) fail("PLY has no header");
    /* The marker is followed by a newline; the body starts after it. */
    var bodyAt = i;
    while (bodyAt < bytes.length && (bytes[bodyAt] === 10 || bytes[bodyAt] === 13)) bodyAt++;
    var binary = /format\s+binary_little_endian/.test(head);
    var bigEndian = /format\s+binary_big_endian/.test(head);
    if (bigEndian) fail("big-endian PLY files are not supported");

    /* Header → elements, each with its own property list. */
    var elements = [];
    head.split(/\r?\n/).forEach(function (line) {
      var parts = line.trim().split(/\s+/);
      if (parts[0] === "element") {
        elements.push({ name: parts[1], count: parseInt(parts[2], 10), props: [] });
      } else if (parts[0] === "property" && elements.length) {
        var current = elements[elements.length - 1];
        if (parts[1] === "list") {
          current.props.push({ list: true, countType: parts[2], itemType: parts[3], name: parts[4] });
        } else {
          current.props.push({ list: false, type: parts[1], name: parts[2] });
        }
      }
    });

    var vertexEl = elements.filter(function (e) { return e.name === "vertex"; })[0];
    var faceEl = elements.filter(function (e) { return e.name === "face"; })[0];
    if (!vertexEl) fail("PLY has no vertex element");
    var positions = new Float32Array(vertexEl.count * 3);
    var tris = [];

    function pushFace(indices) {
      for (var k = 2; k < indices.length; k++) {
        tris.push(indices[0], indices[k - 1], indices[k]);
      }
    }

    if (!binary) {
      var rows = decodeText(bytes.subarray(bodyAt)).split(/\r?\n/);
      var row = 0;
      while (row < rows.length && !rows[row].trim()) row++;
      var skip = function (n) { row += n; };
      for (var e = 0; e < elements.length; e++) {
        var element = elements[e];
        if (element.name === "vertex") {
          for (var v = 0; v < element.count && row < rows.length; v++, row++) {
            var nums = rows[row].trim().split(/\s+/).map(Number);
            positions[v * 3] = nums[0] || 0;
            positions[v * 3 + 1] = nums[1] || 0;
            positions[v * 3 + 2] = nums[2] || 0;
          }
        } else if (element.name === "face") {
          for (var f = 0; f < element.count && row < rows.length; f++, row++) {
            var list = rows[row].trim().split(/\s+/).map(Number);
            pushFace(list.slice(1, 1 + list[0]));
            if (tris.length / 3 >= MAX_TRIANGLES) break;
          }
          skip(0);
        } else {
          skip(element.count);
        }
      }
    } else {
      var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      var off = bodyAt;
      function read(type) {
        var size = PLY_SIZE[type] || 4;
        var value = dv[PLY_GET[type] || "getFloat32"](off, true);
        off += size;
        return value;
      }
      for (var el = 0; el < elements.length; el++) {
        var item = elements[el];
        for (var n = 0; n < item.count; n++) {
          var values = {};
          for (var p = 0; p < item.props.length; p++) {
            var prop = item.props[p];
            if (prop.list) {
              var count = read(prop.countType);
              var items = [];
              for (var c = 0; c < count; c++) items.push(read(prop.itemType));
              values[prop.name] = items;
            } else {
              values[prop.name] = read(prop.type);
            }
          }
          if (item.name === "vertex") {
            positions[n * 3] = values.x || 0;
            positions[n * 3 + 1] = values.y || 0;
            positions[n * 3 + 2] = values.z || 0;
          } else if (item.name === "face") {
            var idx = values.vertex_indices || values.vertex_index || [];
            if (idx.length >= 3) pushFace(idx);
          }
        }
      }
    }

    if (!tris.length) fail("PLY has vertices but no faces");
    var pos = new Float32Array(positions);
    var bad = tris.some(function (n) { return n < 0 || n >= pos.length / 3; });
    if (bad) fail("PLY refers to vertices it does not define");
    return mesh(expand(tris.slice(0, MAX_TRIANGLES * 3), pos));
  }

  /* ---------- glTF 2.0: .glb, and .gltf with embedded buffers ---------- */

  var COMPONENT = {
    5120: { size: 1, get: "getInt8", norm: 127 },
    5121: { size: 1, get: "getUint8", norm: 255 },
    5122: { size: 2, get: "getInt16", norm: 32767 },
    5123: { size: 2, get: "getUint16", norm: 65535 },
    5125: { size: 4, get: "getUint32", norm: 4294967295 },
    5126: { size: 4, get: "getFloat32", norm: 1 },
  };
  var WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

  function readAccessor(json, binChunk, index) {
    var acc = json.accessors[index];
    var bv = json.bufferViews[acc.bufferView];
    var view = binChunk ? binChunk.views[acc.bufferView] : null;
    if (!view || !view.bytes) return null;
    var comp = COMPONENT[acc.componentType];
    var width = WIDTH[acc.type] || 1;
    var stride = bv.byteStride || comp.size * width;
    var base = acc.byteOffset || 0;
    var dv = new DataView(view.bytes.buffer, view.bytes.byteOffset, view.bytes.byteLength);
    var out = new Float32Array(acc.count * width);
    for (var i = 0; i < acc.count; i++) {
      for (var w = 0; w < width; w++) {
        var at = base + i * stride + w * comp.size;
        var value = dv[comp.get](at, true);
        if (acc.normalized && comp.norm !== 1) value = value / comp.norm;
        out[i * width + w] = value;
      }
    }
    return { values: out, width: width, count: acc.count };
  }

  function transformPoint(m, x, y, z) {
    if (!m) return [x, y, z];
    return [
      m[0] * x + m[4] * y + m[8] * z + m[12],
      m[1] * x + m[5] * y + m[9] * z + m[13],
      m[2] * x + m[6] * y + m[10] * z + m[14],
    ];
  }

  function multiply(a, b) {
    var out = new Array(16).fill(0);
    for (var c = 0; c < 4; c++) {
      for (var r = 0; r < 4; r++) {
        var sum = 0;
        for (var k = 0; k < 4; k++) sum += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = sum;
      }
    }
    return out;
  }

  function nodeMatrix(node) {
    if (node.matrix) return node.matrix.slice();
    var t = node.translation || [0, 0, 0];
    var r = node.rotation || [0, 0, 0, 1];
    var s = node.scale || [1, 1, 1];
    var x = r[0], y = r[1], z = r[2], w = r[3];
    var x2 = x + x, y2 = y + y, z2 = z + z;
    var xx = x * x2, xy = x * y2, xz = x * z2;
    var yy = y * y2, yz = y * z2, zz = z * z2;
    var wx = w * x2, wy = w * y2, wz = w * z2;
    return [
      (1 - (yy + zz)) * s[0], (xy + wz) * s[0], (xz - wy) * s[0], 0,
      (xy - wz) * s[1], (1 - (xx + zz)) * s[1], (yz + wx) * s[1], 0,
      (xz + wy) * s[2], (yz - wx) * s[2], (1 - (xx + yy)) * s[2], 0,
      t[0], t[1], t[2], 1,
    ];
  }

  function parseGLTF(json, buffers) {
    if (!json || !json.asset) fail("this is not a glTF file");
    if (json.asset.version && String(json.asset.version).charAt(0) !== "2") {
      if (String(json.asset.version).charAt(0) === "1") fail("glTF 1.0 is not supported — re-export as glTF 2.0 (.glb)");
    }
    var binChunk = buffers && buffers.length ? buffers[0] : null;
    var views = [];
    if (binChunk) {
      (json.bufferViews || []).forEach(function (bv) {
        var bufferIndex = bv.buffer || 0;
        var buf = buffers[bufferIndex];
        if (!buf) { views.push(null); return; }
        views.push({
          /* Already sliced to the bufferView, so accessor offsets are relative
             to this array and nothing has to be added twice. */
          bytes: buf.subarray(bv.byteOffset || 0, (bv.byteOffset || 0) + bv.byteLength),
          byteStride: bv.byteStride,
        });
      });
    }

    var out = [];
    var meshes = 0;
    var warnings = [];
    var nodes = json.nodes || [];
    var scene = json.scenes && json.scenes[json.scene || 0];

    function emit(positions, indices, matrix) {
      var p = [];
      var n = indices ? indices.values.length : positions.count;
      var pv = positions.values;
      for (var i = 0; i < n; i++) {
        var vi = indices ? indices.values[i] : i;
        var x = pv[vi * positions.width];
        var y = pv[vi * positions.width + 1];
        var z = pv[vi * positions.width + 2];
        var t = transformPoint(matrix, x, y, z);
        p.push(t[0], t[1], t[2]);
      }
      /* glTF is right-handed with +Z forward; STL/OBJ viewers often get Y-up
         handled by the camera, so nothing is rotated here. */
      out.push(new Float32Array(p));
    }

    function readNode(nodeIndex, parentMatrix, depth) {
      if (depth > 24) return;
      var node = nodes[nodeIndex];
      if (!node) return;
      var matrix = multiply(parentMatrix, nodeMatrix(node));
      if (node.mesh !== undefined && json.meshes && json.meshes[node.mesh]) {
        var meshDef = json.meshes[node.mesh];
        meshes++;
        (meshDef.primitives || []).forEach(function (prim) {
          if (prim.mode !== undefined && prim.mode !== 4) {
            warnings.push("some primitives are not triangles and were skipped");
            return;
          }
          var pos = readAccessor(json, { views: views }, prim.attributes.POSITION);
          if (!pos) return;
          var idx = prim.indices !== undefined ? readAccessor(json, { views: views }, prim.indices) : null;
          emit(pos, idx, matrix);
        });
      }
      (node.children || []).forEach(function (child) { readNode(child, matrix, depth + 1); });
    }

    var identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    if (scene && scene.nodes) scene.nodes.forEach(function (n) { readNode(n, identity, 0); });
    else nodes.forEach(function (_, i) { readNode(i, identity, 0); });

    var total = 0;
    out.forEach(function (a) { total += a.length; });
    if (!total) fail("this glTF has no triangles to draw");
    var merged = new Float32Array(total);
    var at = 0;
    out.forEach(function (a) { merged.set(a, at); at += a.length; });
    return mesh(merged, { meshes: Math.max(1, meshes), warning: warnings.join("; ") });
  }

  function parseGLB(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < 20) fail("GLB is too short to be a file");
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) fail("not a GLB (bad magic)");
    var version = dv.getUint32(4, true);
    if (version !== 2) fail("only glTF 2.0 GLB files are supported (this one is version " + version + ")");
    var offset = 12;
    var json = null;
    var buffers = [];
    while (offset + 8 <= bytes.byteLength) {
      var length = dv.getUint32(offset, true);
      var type = dv.getUint32(offset + 4, true);
      var body = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(decodeText(body));
      else if (type === 0x004e4942) buffers.push(body);
      offset += 8 + length + ((4 - (length % 4)) % 4);
    }
    if (!json) fail("GLB has no JSON chunk");
    return parseGLTF(json, buffers);
  }

  /* glTF 2.0 files can embed their buffers as data: URIs; external .bin files
     cannot be followed from here, so say that instead of drawing half a model. */
  function parseGLTFText(text) {
    var json = JSON.parse(text);
    var buffers = [];
    var missing = 0;
    (json.buffers || []).forEach(function (b) {
      var m = /^data:[^;,]*;base64,(.*)$/.exec(b.uri || "");
      if (m) buffers.push(base64ToBytes(m[1]));
      else { buffers.push(null); missing++; }
    });
    if (missing) {
      /* Nothing can be read without the buffers, so do not pretend: hand back
         an empty mesh carrying the explanation, and let the app show it. */
      return {
        kind: "mesh",
        positions: new Float32Array(0),
        triangles: 0,
        meshes: 0,
        bounds: null,
        warning:
          "This .gltf keeps its geometry in a separate .bin file, which a preview cannot fetch. " +
          "Save it as a single .glb (or re-export with embedded buffers) to see the model.",
      };
    }
    return parseGLTF(json, buffers);
  }

  /* ---------- ISO 9660 directory listing ---------- */

  function parseISO(buffer) {
    var bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (bytes.byteLength < 32768 + 2048) fail("that is too small to be an ISO image");
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    var pvd = 32768;
    function tag(at) { return decodeText(bytes.subarray(at, at + 5)); }
    if (tag(pvd + 1) !== "CD001") {
      if (bytes.byteLength >= 18 * 2048 && tag(16 * 2048 + 1) === "CD001") {
        fail("this ISO uses another filesystem (not ISO9660)");
      }
      fail("no ISO9660 volume descriptor — this may be UDF, Joliet-only or not an ISO");
    }
    var label = decodeText(bytes.subarray(pvd + 40, pvd + 72)).replace(/\0+$/, "").trim();
    var rootLen = bytes[pvd + 156];
    var rootAt = pvd + 156;
    var rootLba = dv.getUint32(rootAt + 2, true);
    var rootSize = dv.getUint32(rootAt + 10, true);

    var entries = [];
    var LIMIT = 3000;

    function walk(lba, size, depth, prefix) {
      var start = lba * 2048;
      var end = Math.min(start + size, bytes.byteLength);
      var at = start;
      while (at < end && entries.length < LIMIT) {
        var len = bytes[at];
        if (len === 0) {
          /* Records never cross a sector: skip to the next one. */
          at = (Math.floor(at / 2048) + 1) * 2048;
          continue;
        }
        var extLen = bytes[at + 1];
        var childLba = dv.getUint32(at + 2, true);
        var childSize = dv.getUint32(at + 10, true);
        var flags = bytes[at + 25];
        var nameLen = bytes[at + 32];
        var name = decodeText(bytes.subarray(at + 33, at + 33 + nameLen));
        var isDir = (flags & 2) !== 0;
        var isHidden = (flags & 1) !== 0;

        /* 0x00 = "this directory", 0x01 = "parent directory". */
        if (!(nameLen === 1 && (name.charCodeAt(0) === 0 || name.charCodeAt(0) === 1))) {
          var clean = name.replace(/;1$/, "");
          if (!isHidden) {
            entries.push({
              name: clean,
              path: prefix ? prefix + "/" + clean : clean,
              isDir: isDir,
              size: isDir ? 0 : childSize,
              depth: depth,
            });
            if (isDir && depth < 2) walk(childLba, childSize, depth + 1, prefix ? prefix + "/" + clean : clean);
          }
        }
        at += len + (len % 2);
      }
    }

    walk(rootLba, rootSize, 0, "");
    return { kind: "iso", label: label || "(no label)", entries: entries, truncated: entries.length >= LIMIT };
  }

  /* ---------- text ---------- */

  function decodeText(bytes) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(bytes);
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function base64ToBytes(b64) {
    var clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
    if (typeof atob === "function") {
      var raw = atob(clean);
      var out = new Uint8Array(raw.length);
      for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
      return out;
    }
    return new Uint8Array(Buffer.from(clean, "base64"));
  }

  var api = {
    parseSTL: parseSTL,
    parseOBJ: parseOBJ,
    parsePLY: parsePLY,
    parseGLB: parseGLB,
    parseGLTFText: parseGLTFText,
    parseISO: parseISO,
    bounds: bounds,
    MAX_TRIANGLES: MAX_TRIANGLES,
  };

  root.PreviewParsers = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
