/* Interactive paper-fold confetti (Three.js).
   One page-sized canvas holds every piece: the hero scatter, the side pieces,
   and the footer pile hiding the sign-off message. The canvas is anchored to
   the page and scrolls with it, resizing when the page height changes (e.g.
   accordions opening). Run the cursor onto a piece and it curls away from
   you; pile pieces flip at a touch; on mobile, tap a piece to flip it. */
(function () {
  var YELLOW = 'rgb(255,210,75)';
  var GREEN = 'rgb(30,171,84)';
  var R = 9; // fold radius

  var pageEl = document.querySelector('.page');
  var layer = document.getElementById('flip-layer');
  var mx = null, my = null;
  // hover-folding is a mouse interaction; touch gets tap-to-flip instead
  // (touch pointermove during scrolling must not trigger folds)
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType !== 'touch') { mx = e.clientX; my = e.clientY; }
  });

  var renderer = null, scene, cam, pieces, dirty, canW, canH;
  var pileMsgY = 0; // page-space Y of the footer message centre, to track layout shifts
  var originX = 0, originY = 0; // canvas origin in document coords, cached at setup
  var prevActive = false; // was anything moving last frame (skip idle work otherwise)
  var hmx = null, hmy = null, hsy = null; // pointer/scroll state last hit-tested
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasAnimated = false; // throw-in plays on first load only, not on resize rebuilds

  // shared scratch objects: the frame loop must not allocate
  var SQ = new THREE.Quaternion(), SV = new THREE.Vector3();
  var ZAXIS = new THREE.Vector3(0, 0, 1);
  var geoCache = {}; // pieces of the same shape and scale share one geometry

  var VERT = 'uniform float uFold,uR,uZSign;uniform vec2 uDir;varying vec2 vUv;varying float vDist;void main(){vUv=uv;vec2 dir=normalize(uDir);vec3 p=position;float s=dot(position.xy,dir);float dist=uFold-s;if(dist>0.0){float a=dist/uR;float along;float z;if(a<=3.14159265){along=uFold-uR*sin(a);z=uR*(1.0-cos(a));}else{along=uFold+(dist-3.14159265*uR);z=2.0*uR;}p.xy=position.xy+dir*(along-s);p.z+=z*uZSign;}vDist=dist;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}';
  // flat shading: no fold gradient or shadow, just a solid tint per face.
  // 0.8 alpha per piece, so overlapping pieces visibly stack darker
  var FRAG = 'uniform vec3 uCol;uniform float uShape,uR,uZSign;varying vec2 vUv;varying float vDist;void main(){if(uShape>0.5 && length(vUv-0.5)>0.5) discard;vec3 col=uCol;float back=(uZSign>0.0)?0.0:1.0;if(vDist>uR*1.5707963) back=1.0-back;if(back>0.5) col*=0.955;gl_FragColor=vec4(col,0.8);}';

  function mkPiece(type, cx, cy, rot, sc) {
    var w = (type === 'circle' ? 159 : 85) * sc, h = (type === 'circle' ? 159 : 252) * sc;
    var gk = type + sc;
    var geo = geoCache[gk] || (geoCache[gk] = new THREE.PlaneGeometry(w, h, 40, 40));
    var uniforms = {
      uFold: { value: -99999 }, uDir: { value: new THREE.Vector2(1, 0) }, uR: { value: R },
      uZSign: { value: 1.0 }, uShape: { value: type === 'circle' ? 1 : 0 },
      uCol: { value: new THREE.Color(type === 'circle' ? YELLOW : GREEN) }
    };
    var mat = new THREE.ShaderMaterial({
      uniforms: uniforms, side: THREE.DoubleSide, transparent: true,
      vertexShader: VERT, fragmentShader: FRAG
    });
    var mesh = new THREE.Mesh(geo, mat);
    var z = pieces.length * 40; // own z-layer per piece, spaced wider than max curl height (2R=36), so curls never poke through neighbours
    mesh.position.set(cx, cy, z);
    mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot || 0);
    scene.add(mesh);
    var t = { mesh: mesh, uniforms: uniforms, w: w, h: h, type: type, cx: cx, cy: cy, z: z,
      boundR: Math.hypot(w, h) / 2 + 2, // circumscribed radius for the cheap pre-test
      pile: false, landed: true, armed: true, fold: -99999, dragging: false, settleTo: null,
      lockDir: null, flipDirWorld: null, entryProj: 0, flatG: 0, overG: 0, midG: 0, eG: 0 };
    pieces.push(t);
    return t;
  }

  // is (wx, wy) inside the piece? Cheap bounding-radius rejection first, exact
  // rotated-shape test after. Leaves the local coords in SV for the caller.
  function localHit(t, wx, wy) {
    if (Math.abs(wx - t.cx) > t.boundR || Math.abs(wy - t.cy) > t.boundR) return false;
    SQ.copy(t.mesh.quaternion).invert();
    SV.set(wx - t.cx, wy - t.cy, 0).applyQuaternion(SQ);
    return t.type === 'circle' ? Math.hypot(SV.x, SV.y) <= t.w / 2 : Math.abs(SV.x) <= t.w / 2 && Math.abs(SV.y) <= t.h / 2;
  }

  // flip direction away from the local hit point in SV (set by localHit)
  function dirFromHit() {
    var L = Math.hypot(SV.x, SV.y);
    return L > 4 ? new THREE.Vector2(-SV.x / L, -SV.y / L) : new THREE.Vector2(1, 0);
  }

  // start an automatic roll-right-over in the given direction
  function triggerFlip(t, dir) {
    t.lockDir = dir;
    t.uniforms.uDir.value.copy(dir);
    t.eG = (Math.abs(dir.x) * t.w + Math.abs(dir.y) * t.h) / 2;
    t.flatG = -t.eG - 4;
    t.overG = t.eG + Math.PI * R;
    t.midG = (t.flatG + t.overG) / 2;
    t.fold = t.flatG;
    t.settleTo = t.overG;
    finalizeDir(t);
  }

  // advance a settling fold; completes the flip-over when it lands past overG.
  // pieces are free to flip right off the page edges
  function advanceSettle(t, rate) {
    t.fold += (t.settleTo - t.fold) * rate;
    if (Math.abs(t.fold - t.settleTo) < 1) {
      var landedOver = (t.settleTo === t.overG);
      t.fold = t.settleTo; t.settleTo = null;
      if (landedOver && t.flipDirWorld) {
        var d = t.flipDirWorld, disp = 2 * t.eG + Math.PI * R;
        t.cx += d.x * disp; t.cy += d.y * disp;
        t.mesh.position.set(t.cx, t.cy, t.z);
        var axis = new THREE.Vector3(-d.y, d.x, 0).normalize();
        t.mesh.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(axis, Math.PI));
        t.uniforms.uZSign.value = upSign(t.mesh.quaternion);
        t.fold = -99999; t.flipDirWorld = null; t.armed = false;
      } else { t.flipDirWorld = null; t.fold = -99999; }
    }
    t.uniforms.uFold.value = t.fold;
  }

  function upSign(q) {
    return new THREE.Vector3(0, 0, 1).applyQuaternion(q).z >= 0 ? 1 : -1;
  }

  function finalizeDir(t) {
    if (t.settleTo === t.overG && t.lockDir) {
      var w = new THREE.Vector3(t.lockDir.x, t.lockDir.y, 0).applyQuaternion(t.mesh.quaternion);
      t.flipDirWorld = new THREE.Vector2(w.x, w.y).normalize();
    }
    t.lockDir = null;
  }

  // footer photo box in page coords; valid pre-load thanks to the img's
  // width/height attributes (the layout box exists before the pixels arrive)
  function photoBox() {
    var img = document.querySelector('.footer-photo');
    if (!img) return null;
    var r = img.getBoundingClientRect(), p = pageEl.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return null;
    return { left: r.left - p.left, right: r.right - p.left, top: r.top - p.top, bottom: r.bottom - p.top };
  }

  function msgCentre() {
    var span = document.querySelector('.footer-message span');
    var srect = span.getBoundingClientRect(), prect = pageEl.getBoundingClientRect();
    return {
      left: srect.left - prect.left, right: srect.right - prect.left,
      x: srect.left - prect.left + srect.width / 2,
      y: srect.top - prect.top + srect.height / 2
    };
  }

  function setup() {
    if (renderer) { renderer.dispose(); layer.replaceChildren(); }
    var mobile = window.matchMedia('(max-width: 700px)').matches;
    var W = window.innerWidth, PH = pageEl.clientHeight || 4980;
    canW = W; canH = PH;
    // preserveDrawingBuffer: scissored partial renders rely on the rest of the
    // canvas persisting between frames, which is otherwise not guaranteed
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    // page-anchored canvas scrolls natively with the text (zero lag); dpr capped so PH*dpr stays under common renderbuffer limits
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2, 8192 / PH));
    renderer.setSize(W, PH);
    // setSize gives the canvas an explicit px height; keep it (not 100%) so the
    // canvas doesn't stretch while the page height animates (accordions) —
    // onPageResize follows the movement instead
    renderer.domElement.style.display = 'block';
    layer.appendChild(renderer.domElement);
    var lrect = layer.getBoundingClientRect();
    originX = lrect.left + window.scrollX;
    originY = lrect.top + window.scrollY;
    scene = new THREE.Scene();
    cam = new THREE.OrthographicCamera(0, W, 0, PH, -3000, 3000);
    cam.position.z = 2000;
    dirty = true;
    pieces = [];

    var SC = mobile ? 0.5 : 0.85; // global confetti scale
    function mk(type, cx, cy, rot) { mkPiece(type, cx, cy, rot, SC); }
    var sideX = function (left) { return left ? 60 + Math.random() * 120 : W - 60 - Math.random() * 120; };

    // hero: dense edge-weighted scatter, alternating yellow/green, 2 pieces over the title
    var heroN = 12;
    var heroYSpan = mobile ? window.innerHeight - 160 : 660;
    for (var i = 0; i < heroN; i++) {
      var dot = i % 2 === 0;
      // bias x toward the edges: map u in 0..1 through an ease that clusters at 0 and 1
      var u = (i + Math.random() * 0.8) / heroN;
      var edge = u < 0.5 ? Math.pow(u * 2, 1.6) / 2 : 1 - Math.pow((1 - u) * 2, 1.6) / 2;
      mk(dot ? 'circle' : 'rect', 70 + edge * (W - 140), 40 + Math.random() * heroYSpan, dot ? 0 : (Math.random() - 0.5) * 1.6);
    }
    // two pieces overlapping the title
    var titleX = mobile ? Math.min(W * 0.3, 120) : 180;
    var titleY = mobile ? window.innerHeight / 2 : 270;
    mk('circle', W / 2 - titleX - Math.random() * 40, titleY + Math.random() * 60, 0);
    mk('rect', W / 2 + titleX + Math.random() * 40, titleY - 20 + Math.random() * 80, (Math.random() - 0.5) * 1.2);

    if (!mobile) {
      // schedule band: the yellow dots carry the times, so only green rects here, on the sides
      var side = Math.random() < 0.5;
      for (var y = 1120; y < 2400; y += 240 + Math.random() * 180) {
        mk('rect', sideX(side), y, (Math.random() - 0.5) * 1.6);
        side = !side;
      }
      // below the schedule: mixed shapes, sides only
      var alt = 0;
      for (y = 2500; y < 4400; y += 300 + Math.random() * 240) {
        var d = alt++ % 2 === 0;
        mk(d ? 'circle' : 'rect', sideX(side), y, d ? 0 : (Math.random() - 0.5) * 1.6);
        side = !side;
      }
    }

    // footer pile: a heap hiding the photo and the sign-off message. First a
    // guaranteed cover — a jittered grid over the photo box and a row along
    // the measured text — then a scatter heaped around the whole cluster.
    var mc = msgCentre();
    pileMsgY = mc.y;
    var psc = mobile ? 0.5 : 0.62;
    var pn = 0;
    var step = mobile ? 46 : 60;
    var pb = photoBox();
    if (pb) {
      for (var gy = pb.top + step / 2.5; gy < pb.bottom; gy += step) {
        for (var gx = pb.left + step / 3; gx < pb.right; gx += step) {
          var gd = pn++ % 2 === 0;
          mkPiece(gd ? 'circle' : 'rect',
            gx + (Math.random() - 0.5) * 14,
            gy + (Math.random() - 0.5) * 14,
            (Math.random() - 0.5) * 2.6, psc).pile = true;
        }
      }
    }
    for (var px = mc.left + step / 3; px < mc.right; px += step) {
      var pd = pn++ % 2 === 0;
      mkPiece(pd ? 'circle' : 'rect',
        px + (Math.random() - 0.5) * 12,
        mc.y + (Math.random() - 0.5) * 16,
        (Math.random() - 0.5) * 2.6, psc).pile = true;
    }
    var heapY = pb ? (pb.top + mc.y) / 2 : mc.y;
    var spreadX = mobile ? 120 : 250;
    var spreadY = pb ? (mc.y - pb.top) / 2 + 40 : (mobile ? 70 : 80);
    for (i = 0; i < 14; i++) {
      var pd2 = pn++ % 2 === 0;
      var ang = Math.random() * Math.PI * 2;
      var r = Math.pow(Math.random(), 0.6); // cluster toward the centre
      mkPiece(pd2 ? 'circle' : 'rect',
        mc.x + Math.cos(ang) * r * spreadX,
        heapY + Math.sin(ang) * r * spreadY,
        (Math.random() - 0.5) * 2.6, psc).pile = true;
    }

    // throw-in: only the confetti visible on load (the hero scatter) is thrown
    // from the centre-bottom edge of the screen after the text fade, spinning
    // flat along an arc to its landing spot. Everything below the fold is
    // simply placed — snappier, and nobody sees it arrive anyway.
    if (!hasAnimated && !reduceMotion) {
      var oy = Math.min(PH, window.innerHeight) + 180;
      var t0 = performance.now() + 700;
      var order = pieces.filter(function (t) { return t.cy < window.innerHeight + 100; });
      for (var k = order.length - 1; k > 0; k--) { var j = Math.floor(Math.random() * (k + 1)); var tmp = order[k]; order[k] = order[j]; order[j] = tmp; }
      order.forEach(function (t, idx) {
        t.landed = false;
        t.qFinal = t.mesh.quaternion.clone();
        t.throwT0 = t0 + idx * 55 + Math.random() * 120;
        t.throwDur = 900 + Math.random() * 500;
        t.sx = W / 2 + (Math.random() - 0.5) * 60;
        t.sy = oy;
        // arc control point: past the midpoint and well above both ends
        t.cpx = (t.sx + t.cx) / 2 + (t.cx - t.sx) * 0.25;
        t.cpy = Math.min(t.sy, t.cy) - (250 + Math.random() * 350);
        // flat scatter: pieces stay face-on, spinning only in the screen plane
        t.tumbleSpin = (Math.random() < 0.5 ? -1 : 1) * Math.PI * (1.5 + Math.random() * 2);
        t.mesh.visible = false;
      });
    }
    hasAnimated = true;
    prevActive = true; // run the loop at least once (drives the throw-in)
  }

  // page height changes (accordions opening/closing): called every
  // ResizeObserver tick so the pile tracks the animating accordion frame by
  // frame instead of jumping once at the end. The buffer only ever grows
  // (with headroom), so mid-animation follows never reallocate; the canvas
  // overhang past the page bottom is clipped by the layer's overflow:hidden
  function onPageResize() {
    if (!renderer || pageEl.clientWidth !== canW) return; // width changes rebuild via the resize listener
    var PH = pageEl.clientHeight;
    if (PH > canH) {
      canH = PH + 600;
      renderer.setPixelRatio(Math.min(devicePixelRatio, 2, 8192 / canH));
      renderer.setSize(canW, canH);
      cam.bottom = canH;
      cam.updateProjectionMatrix();
    }
    var dy = msgCentre().y - pileMsgY;
    if (Math.abs(dy) < 0.1) return;
    pileMsgY += dy;
    for (var i = 0; i < pieces.length; i++) {
      var t = pieces[i];
      if (t.pile) { t.cy += dy; t.mesh.position.y = t.cy; }
    }
    dirty = true;
  }

  function step(now) {
    if (!pieces || !renderer) return;
    // idle fast path: nothing animating and the pointer/scroll hasn't changed
    var sy = window.scrollY;
    var moved = mx !== hmx || my !== hmy || sy !== hsy;
    if (!prevActive && !moved) {
      if (dirty) { renderer.render(scene, cam); dirty = false; }
      return;
    }
    hmx = mx; hmy = my; hsy = sy;
    var wx = null, wy = null;
    if (mx != null) {
      wx = mx + window.scrollX - originX;
      wy = my + sy - originY;
    }
    var active = false, flying = false;
    var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (var i = 0; i < pieces.length; i++) {
      var t = pieces[i];
      if (!t.landed) {
        active = true; flying = true;
        var e = (now - t.throwT0) / t.throwDur;
        if (e >= 1) {
          t.landed = true;
          t.mesh.visible = true;
          t.mesh.position.set(t.cx, t.cy, t.z);
          t.mesh.quaternion.copy(t.qFinal);
        } else if (e > 0) {
          t.mesh.visible = true;
          var kk = 1 - Math.pow(1 - e, 3); // ease-out: fast off the hand, slowing to land
          var ik = 1 - kk;
          t.mesh.position.set(
            ik * ik * t.sx + 2 * ik * kk * t.cpx + kk * kk * t.cx,
            ik * ik * t.sy + 2 * ik * kk * t.cpy + kk * kk * t.cy,
            t.z);
          t.mesh.quaternion.copy(t.qFinal)
            .multiply(SQ.setFromAxisAngle(ZAXIS, t.tumbleSpin * ik));
        }
        continue;
      }
      if (wx != null && t.settleTo === null) {
        var inside = localHit(t, wx, wy);
        var lx = SV.x, ly = SV.y;
        if (!inside) {
          t.armed = true;
          if (t.dragging) { t.dragging = false; t.settleTo = (t.fold > t.midG) ? t.overG : t.flatG; finalizeDir(t); }
        } else if (t.armed) {
          if (t.pile) {
            // pile pieces flip away at a touch
            triggerFlip(t, dirFromHit());
          } else {
            if (!t.dragging) {
              var Ld = Math.hypot(lx, ly) || 1;
              t.lockDir = new THREE.Vector2(-lx / Ld, -ly / Ld);
              t.uniforms.uDir.value.copy(t.lockDir);
              t.entryProj = lx * t.lockDir.x + ly * t.lockDir.y;
              t.eG = (Math.abs(t.lockDir.x) * t.w + Math.abs(t.lockDir.y) * t.h) / 2;
              t.flatG = -t.eG - 4;
              t.overG = t.eG + Math.PI * R;
              t.midG = (t.flatG + t.overG) / 2;
              t.fold = t.flatG;
              t.dragging = true;
            }
            var proj = lx * t.lockDir.x + ly * t.lockDir.y;
            var prog = (proj - t.entryProj) / (2 * t.eG); prog = Math.min(Math.max(prog, 0), 1);
            var targetFold = t.flatG + (t.overG - t.flatG) * prog;
            t.fold += (targetFold - t.fold) * 0.6;
          }
        }
      }
      if (!t.dragging && t.settleTo !== null) advanceSettle(t, t.pile ? 0.3 : 0.16);
      t.uniforms.uFold.value = t.fold;
      if (t.dragging || t.settleTo !== null) {
        active = true;
        // grow the dirty region: generous margin covers the curl and flip-over displacement
        var m = 2.5 * Math.max(t.w, t.h);
        bx0 = Math.min(bx0, t.cx - m); by0 = Math.min(by0, t.cy - m);
        bx1 = Math.max(bx1, t.cx + m); by1 = Math.max(by1, t.cy + m);
      }
    }
    prevActive = active;
    // page-anchored: scrolling needs no redraw; render only during interaction (+1 settle frame).
    // While anything is moving, scissor to the changing region — repainting the whole
    // page-height canvas every frame is what causes throw-in lag.
    if (active || dirty) {
      if (active) {
        if (flying) {
          // the throw plays out in (and just beyond) the visible viewport
          bx0 = 0; bx1 = canW;
          by0 = Math.min(by0, window.scrollY - 300);
          by1 = Math.max(by1, window.scrollY + window.innerHeight + 300);
        }
        bx0 = Math.max(0, bx0); by0 = Math.max(0, by0);
        bx1 = Math.min(canW, bx1); by1 = Math.min(canH, by1);
        renderer.setScissorTest(true);
        renderer.setScissor(bx0, canH - by1, bx1 - bx0, by1 - by0);
        renderer.render(scene, cam);
        renderer.setScissorTest(false);
        dirty = true; // one full pass once everything settles, to finalize the canvas
      } else {
        renderer.render(scene, cam);
        dirty = false;
      }
    }
  }

  // tap-to-flip: a touch on a resting piece rolls it right over, folding
  // away from the tap point. A desktop click instead flips every resting
  // piece near the cursor, each away from the click point.
  window.addEventListener('pointerdown', function (e) {
    if (!pieces || !renderer) return;
    var wx = e.clientX + window.scrollX - originX;
    var wy = e.clientY + window.scrollY - originY;
    if (e.pointerType === 'mouse') {
      if (e.button !== 0) return;
      var RADIUS = 200;
      var any = false;
      for (var i = 0; i < pieces.length; i++) {
        var t = pieces[i];
        if (!t.landed || t.dragging || t.settleTo !== null) continue;
        var dx = t.cx - wx, dy = t.cy - wy;
        var d = Math.hypot(dx, dy);
        if (d > RADIUS) continue;
        // world-space "away from cursor", converted to the piece's local
        // space (triggerFlip expects a local direction, like dirFromHit)
        SV.set(d > 4 ? dx / d : 1, d > 4 ? dy / d : 0, 0)
          .applyQuaternion(SQ.copy(t.mesh.quaternion).invert());
        triggerFlip(t, new THREE.Vector2(SV.x, SV.y).normalize());
        any = true;
      }
      if (any) prevActive = true; // wake the loop from its idle fast path
      return;
    }
    for (var j = pieces.length - 1; j >= 0; j--) { // topmost piece first
      var t2 = pieces[j];
      if (!t2.landed || t2.dragging || t2.settleTo !== null) continue;
      if (localHit(t2, wx, wy)) {
        triggerFlip(t2, dirFromHit());
        prevActive = true; // wake the loop from its idle fast path
        return;
      }
    }
  });

  function tick(now) {
    step(now);
    requestAnimationFrame(tick);
  }

  var resizeTimer, lastW = window.innerWidth;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      // width unchanged = mobile URL bar showing/hiding; don't rescatter for that
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      setup();
    }, 150);
  });

  // no debounce: fires every frame of the accordion height transition, and
  // onPageResize is cheap once the buffer has grown
  new ResizeObserver(onPageResize).observe(pageEl);

  setup();
  requestAnimationFrame(tick);
})();
