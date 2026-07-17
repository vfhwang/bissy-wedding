/* Interactive paper-fold confetti (Three.js).
   The canvas is anchored to the page and scrolls with it. Dense scatter over
   the hero, then side confetti only: green rectangles alongside the yellow-dot
   schedule, mixed shapes further down. Run the cursor onto a piece and it
   curls away from you; leave mid-fold and it settles flat or flips right over
   onto its other side. */
(function () {
  var YELLOW = 'rgb(255,210,75)';
  var GREEN = 'rgb(30,171,84)';
  var PAGE_H = 4980;
  var R = 9; // fold radius

  var layer = document.getElementById('flip-layer');
  var mx = null, my = null;
  window.addEventListener('pointermove', function (e) { mx = e.clientX; my = e.clientY; });

  var renderer = null, scene, cam, pieces, dirty;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasAnimated = false; // throw-in plays on first load only, not on resize rebuilds

  var VERT = 'uniform float uFold,uR,uZSign;uniform vec2 uDir;varying vec2 vUv;varying float vDist;void main(){vUv=uv;vec2 dir=normalize(uDir);vec3 p=position;float s=dot(position.xy,dir);float dist=uFold-s;if(dist>0.0){float a=dist/uR;float along;float z;if(a<=3.14159265){along=uFold-uR*sin(a);z=uR*(1.0-cos(a));}else{along=uFold+(dist-3.14159265*uR);z=2.0*uR;}p.xy=position.xy+dir*(along-s);p.z+=z*uZSign;}vDist=dist;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}';
  // flat shading: no fold gradient or shadow, just a solid tint per face
  var FRAG = 'uniform vec3 uCol;uniform float uShape,uR,uZSign;varying vec2 vUv;varying float vDist;void main(){if(uShape>0.5 && length(vUv-0.5)>0.5) discard;vec3 col=uCol;float back=(uZSign>0.0)?0.0:1.0;if(vDist>uR*1.5707963) back=1.0-back;if(back>0.5) col*=0.955;gl_FragColor=vec4(col,1.0);}';

  function setup() {
    if (renderer) { renderer.dispose(); layer.replaceChildren(); }
    var W = window.innerWidth, PH = PAGE_H;
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // page-anchored canvas scrolls natively with the text (zero lag); dpr capped so PH*dpr stays under common renderbuffer limits
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2, 8192 / PH));
    renderer.setSize(W, PH);
    renderer.domElement.style.cssText = 'display:block;width:100%;height:100%';
    layer.appendChild(renderer.domElement);
    scene = new THREE.Scene();
    cam = new THREE.OrthographicCamera(0, W, 0, PH, -3000, 3000);
    cam.position.z = 2000;
    dirty = true;
    pieces = [];

    var SC = 0.85; // global confetti scale
    function mk(type, cx, cy, rot) {
      var w = (type === 'circle' ? 159 : 85) * SC, h = (type === 'circle' ? 159 : 252) * SC;
      var geo = new THREE.PlaneGeometry(w, h, 60, 60);
      var uniforms = {
        uFold: { value: -99999 }, uDir: { value: new THREE.Vector2(1, 0) }, uR: { value: R },
        uZSign: { value: 1.0 }, uShape: { value: type === 'circle' ? 1 : 0 },
        uCol: { value: new THREE.Color(type === 'circle' ? YELLOW : GREEN) }
      };
      var mat = new THREE.ShaderMaterial({
        uniforms: uniforms, side: THREE.DoubleSide, transparent: false,
        vertexShader: VERT, fragmentShader: FRAG
      });
      var mesh = new THREE.Mesh(geo, mat);
      var z = pieces.length * 40; // own z-layer per piece, spaced wider than max curl height (2R=36), so curls never poke through neighbours
      mesh.position.set(cx, cy, z);
      mesh.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), rot || 0);
      scene.add(mesh);
      pieces.push({ mesh: mesh, uniforms: uniforms, w: w, h: h, type: type, cx: cx, cy: cy, z: z,
        landed: true, armed: true, fold: -99999, dragging: false, settleTo: null, lockDir: null,
        flipDirWorld: null, entryProj: 0, flatG: 0, overG: 0, midG: 0, eG: 0 });
    }

    var sideX = function (left) { return left ? 60 + Math.random() * 120 : W - 60 - Math.random() * 120; };

    // hero: dense edge-weighted scatter, alternating yellow/green, 2 pieces over the title
    var heroN = 12;
    for (var i = 0; i < heroN; i++) {
      var dot = i % 2 === 0;
      // bias x toward the edges: map u in 0..1 through an ease that clusters at 0 and 1
      var u = (i + Math.random() * 0.8) / heroN;
      var edge = u < 0.5 ? Math.pow(u * 2, 1.6) / 2 : 1 - Math.pow((1 - u) * 2, 1.6) / 2;
      mk(dot ? 'circle' : 'rect', 70 + edge * (W - 140), 40 + Math.random() * 660, dot ? 0 : (Math.random() - 0.5) * 1.6);
    }
    // two pieces overlapping the title (centered around x mid, y ~300)
    mk('circle', W / 2 - 180 - Math.random() * 60, 270 + Math.random() * 60, 0);
    mk('rect', W / 2 + 170 + Math.random() * 60, 250 + Math.random() * 80, (Math.random() - 0.5) * 1.2);

    // schedule band: the yellow dots carry the times, so only green rects here, on the sides
    var side = Math.random() < 0.5;
    for (var y = 1120; y < 2400; y += 240 + Math.random() * 180) {
      mk('rect', sideX(side), y, (Math.random() - 0.5) * 1.6);
      side = !side;
    }
    // below the schedule: mixed shapes, sides only
    var alt = 0;
    for (y = 2500; y < 4720; y += 300 + Math.random() * 240) {
      var d = alt++ % 2 === 0;
      mk(d ? 'circle' : 'rect', sideX(side), y, d ? 0 : (Math.random() - 0.5) * 1.6);
      side = !side;
    }

    // throw-in: pieces launch from the centre-bottom edge of the screen after
    // the text fade, tumbling along an arc to their landing spot
    if (!hasAnimated && !reduceMotion) {
      var oy = Math.min(PH, window.innerHeight) + 180;
      var t0 = performance.now() + 700;
      var order = pieces.slice();
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
        t.tumbleAxis = new THREE.Vector3(0, 0, 1);
        t.tumbleSpin = (Math.random() < 0.5 ? -1 : 1) * Math.PI * (1.5 + Math.random() * 2);
        t.mesh.visible = false;
      });
    }
    hasAnimated = true;
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

  function step(now) {
    if (!pieces || !renderer) return;
    var wx = null, wy = null;
    if (mx != null) {
      var lr = renderer.domElement.getBoundingClientRect();
      wx = mx - lr.left; wy = my - lr.top;
    }
    var active = false;
    for (var i = 0; i < pieces.length; i++) {
      var t = pieces[i];
      if (!t.landed) {
        active = true;
        var e = (now - t.throwT0) / t.throwDur;
        if (e >= 1) {
          t.landed = true;
          t.mesh.visible = true;
          t.mesh.position.set(t.cx, t.cy, t.z);
          t.mesh.quaternion.copy(t.qFinal);
        } else if (e > 0) {
          t.mesh.visible = true;
          var k = 1 - Math.pow(1 - e, 3); // ease-out: fast off the hand, slowing to land
          var ik = 1 - k;
          t.mesh.position.set(
            ik * ik * t.sx + 2 * ik * k * t.cpx + k * k * t.cx,
            ik * ik * t.sy + 2 * ik * k * t.cpy + k * k * t.cy,
            t.z);
          t.mesh.quaternion.copy(t.qFinal)
            .multiply(new THREE.Quaternion().setFromAxisAngle(t.tumbleAxis, t.tumbleSpin * ik));
        }
        continue;
      }
      if (wx != null && t.settleTo === null) {
        var qi = t.mesh.quaternion.clone().invert();
        var loc = new THREE.Vector3(wx - t.cx, wy - t.cy, 0).applyQuaternion(qi);
        var lx = loc.x, ly = loc.y;
        var inside = t.type === 'circle' ? Math.hypot(lx, ly) <= t.w / 2 : Math.abs(lx) <= t.w / 2 && Math.abs(ly) <= t.h / 2;
        if (!inside) {
          t.armed = true;
          if (t.dragging) { t.dragging = false; t.settleTo = (t.fold > t.midG) ? t.overG : t.flatG; finalizeDir(t); }
        } else if (t.armed) {
          if (!t.dragging) {
            var L = Math.hypot(lx, ly) || 1;
            t.lockDir = new THREE.Vector2(-lx / L, -ly / L);
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
      if (!t.dragging && t.settleTo !== null) {
        t.fold += (t.settleTo - t.fold) * 0.16;
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
      }
      t.uniforms.uFold.value = t.fold;
      if (t.dragging || t.settleTo !== null) active = true;
    }
    // page-anchored: scrolling needs no redraw; render only during interaction (+1 settle frame)
    if (active || dirty) {
      renderer.render(scene, cam);
      dirty = active;
    }
  }

  function tick(now) {
    step(now);
    requestAnimationFrame(tick);
  }

  var resizeTimer;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(setup, 150);
  });

  setup();
  requestAnimationFrame(tick);
})();
