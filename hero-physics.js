/**
 * Hero toolbox — a glass box (open cardboard-style flaps on top) carrying the
 * tool logos. Grab the box and shake it: the logos rattle around inside and,
 * if you shake hard enough, fly out and tumble around the hero, colliding with
 * the copy and buttons. Loose logos can be grabbed and thrown too.
 *
 * Physics: Matter.js. The box is a kinematic-style compound body (bottom +
 * two walls + two angled flaps) driven by the pointer; logos are dynamic.
 */
(() => {
    'use strict';
    if (typeof Matter === 'undefined') return;

    const { Engine, Bodies, Body, Composite, Constraint, Query } = Matter;

    const hero = document.querySelector('.hero');
    const visual = hero && hero.querySelector('.hero-visual');
    const stage = hero && hero.querySelector('.phys-stage');
    if (!hero || !visual || !stage) return;

    const layerBack = stage.querySelector('.box-layer--back');
    const layerFront = stage.querySelector('.box-layer--front');
    const box3dBack = layerBack.querySelector('.box-3d');
    const box3dFront = layerFront.querySelector('.box-3d');
    const logoLayer = stage.querySelector('.phys-logos');
    const hud = hero.querySelector('.box-hud');
    const repackBtn = document.getElementById('repack-btn');

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Icon paths for everything carried in the box (the X mark rides along with the tools)
    const TOOLS = [
        'figma', 'adobephotoshop', 'adobeillustrator', 'claude',
        'googlegemini', 'openai', 'github', 'visualstudiocode'
    ].map(name => `assets/tools/${name}.svg`).concat('assets/xlogo.svg');

    // Fixed 120 Hz step — two substeps per 60 Hz frame keeps hard shakes from tunnelling.
    const DT = 1000 / 120;
    const TS = DT / (1000 / 60);      // Matter velocities are expressed per 60 Hz frame
    const CAT_BOX = 0x0002, CAT_LOGO = 0x0004, CAT_STATIC = 0x0008;
    const LOGO_SIZE = 52;
    const WALL = 24;                  // physics wall thickness, extends outward from the glass
    const FLAP_ANGLE = 38 * Math.PI / 180;
    const MAX_LOGO_SPEED = 30;
    const MAX_BOX_STEP = 16;          // px per substep
    const VIEW_RX = -18, VIEW_RY = 14; // resting 3D view angle (deg)
    const CEILING = -400;             // invisible lid well above the hero

    const engine = Engine.create({
        gravity: { x: 0, y: 1.15 },
        positionIterations: 10,
        velocityIterations: 8
    });
    const world = engine.world;

    const state = { heroW: 0, heroH: 0, scale: 0, dims: null, home: { x: 0, y: 0 }, zone: null };
    const boxVel = { x: 0, y: 0 };
    const wobble = { x: 0, y: 0 };
    const pointer = { x: 0, y: 0 };
    const logos = [];
    let box = null;
    let boxComOffset = { x: 0, y: 0 };
    let staticBodies = [];
    let drag = null;
    let hoverLogo = null;
    let suppressClick = false;
    let spilled = false;
    let frameCount = 0;

    /* ---------- helpers ---------- */
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
    const rotate = (v, a) => {
        const c = Math.cos(a), s = Math.sin(a);
        return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
    };

    function boxOrigin() {
        const off = rotate(boxComOffset, box.angle);
        return { x: box.position.x - off.x, y: box.position.y - off.y };
    }

    function toBoxLocal(p) {
        const o = boxOrigin();
        return rotate({ x: p.x - o.x, y: p.y - o.y }, -box.angle);
    }

    /* ---------- box ---------- */
    function applyDims() {
        const { w, h, d, f } = state.dims;
        stage.style.setProperty('--bw', `${w}px`);
        stage.style.setProperty('--bh', `${h}px`);
        stage.style.setProperty('--bd', `${d}px`);
        stage.style.setProperty('--bf', `${f}px`);
        stage.style.setProperty('--logo', `${LOGO_SIZE}px`);
    }

    function buildBox(origin) {
        const { w, h, f } = state.dims;
        const filter = { group: 0, category: CAT_BOX, mask: CAT_LOGO };
        const part = (x, y, pw, ph, angle = 0) => Bodies.rectangle(
            origin.x + x, origin.y + y, pw, ph,
            { angle, collisionFilter: filter, friction: 0.35, restitution: 0.15 }
        );
        const fx = Math.sin(FLAP_ANGLE) * f / 2;
        const fy = Math.cos(FLAP_ANGLE) * f / 2;

        box = Body.create({
            label: 'toolbox',
            parts: [
                part(0, h / 2 + WALL / 2, w + WALL * 2, WALL),            // bottom
                part(-w / 2 - WALL / 2, WALL / 2, WALL, h + WALL),        // left wall
                part(w / 2 + WALL / 2, WALL / 2, WALL, h + WALL),         // right wall
                part(-w / 2 - fx, -h / 2 - fy, 8, f, -FLAP_ANGLE),        // left flap
                part(w / 2 + fx, -h / 2 - fy, 8, f, FLAP_ANGLE)           // right flap
            ],
            frictionAir: 0,
            friction: 0.35,
            restitution: 0.15,
            collisionFilter: filter
        });
        Body.setMass(box, 800);
        Body.setInertia(box, Infinity); // logos can't spin it; we drive the angle ourselves
        boxComOffset = { x: box.position.x - origin.x, y: box.position.y - origin.y };
        Composite.add(world, box);
    }

    function clampBoxTarget(t) {
        const { w, h, f } = state.dims;
        const z = state.zone;
        return {
            x: clamp(t.x, Math.max(z.left, 8) + w / 2, Math.min(z.right, state.heroW - 8) - w / 2),
            y: clamp(t.y, Math.max(z.top, 0) + h / 2 + f * 0.8, Math.min(z.bottom, state.heroH) - h / 2 - WALL - 4)
        };
    }

    function driveBox() {
        const o = boxOrigin();

        if (drag && drag.type === 'box') {
            const target = clampBoxTarget({ x: pointer.x - drag.offset.x, y: pointer.y - drag.offset.y });
            boxVel.x = (target.x - o.x) * 0.35;
            boxVel.y = (target.y - o.y) * 0.35;
        } else {
            // Damped spring back home, with a gentle idle bob
            const bob = reduceMotion ? 0 : Math.sin(engine.timing.timestamp * 0.0015) * 4;
            boxVel.x = (boxVel.x + (state.home.x - o.x) * 0.012) * 0.86;
            boxVel.y = (boxVel.y + (state.home.y + bob - o.y) * 0.012) * 0.86;
        }

        const m = Math.hypot(boxVel.x, boxVel.y);
        if (m > MAX_BOX_STEP) {
            boxVel.x *= MAX_BOX_STEP / m;
            boxVel.y *= MAX_BOX_STEP / m;
        }
        Body.setVelocity(box, { x: boxVel.x / TS, y: boxVel.y / TS });

        // Tilt against the direction of travel, like carrying something heavy
        const targetAngle = clamp(-boxVel.x * 0.022, -0.42, 0.42);
        Body.setAngularVelocity(box, ((targetAngle - box.angle) * 0.12) / TS);

        // Cancel gravity on the box (applied by the engine right after this)
        box.force.y -= box.mass * engine.gravity.y * engine.gravity.scale;
    }

    /* ---------- static colliders (hero edges + copy + buttons) ---------- */
    function textLines(el, trimTop, trimBottom) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = [];
        for (const r of range.getClientRects()) {
            if (r.width < 2 || r.height < 2) continue;
            const line = lines.find(l => Math.abs(l.top - r.top) < r.height * 0.5);
            if (line) {
                line.left = Math.min(line.left, r.left);
                line.right = Math.max(line.right, r.right);
                line.top = Math.min(line.top, r.top);
                line.bottom = Math.max(line.bottom, r.bottom);
            } else {
                lines.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
            }
        }
        return lines.map(l => {
            const h = l.bottom - l.top;
            return { left: l.left, right: l.right, top: l.top + h * trimTop, bottom: l.bottom - h * trimBottom };
        });
    }

    function domRects() {
        const rects = [];
        hero.querySelectorAll('.hero-ctas .btn')
            .forEach(el => rects.push(el.getBoundingClientRect()));
        return rects;
    }

    function rebuildStatics(hr) {
        Composite.remove(world, staticBodies);
        staticBodies = [];
        const W = state.heroW, H = state.heroH, T = 200;
        const opts = {
            isStatic: true,
            friction: 0.4,
            restitution: 0.25,
            collisionFilter: { group: 0, category: CAT_STATIC, mask: CAT_LOGO }
        };
        const wallH = H - CEILING + T * 2;
        const wallY = (H + CEILING) / 2;
        staticBodies.push(
            Bodies.rectangle(W / 2, H + T / 2, W + T * 2, T, opts),          // floor
            Bodies.rectangle(W / 2, CEILING - T / 2, W + T * 2, T, opts),    // ceiling
            Bodies.rectangle(-T / 2, wallY, T, wallH, opts),                 // left edge
            Bodies.rectangle(W + T / 2, wallY, T, wallH, opts)               // right edge
        );
        domRects().forEach(r => {
            const w = r.right - r.left, h = r.bottom - r.top;
            if (w < 2 || h < 2) return;
            staticBodies.push(Bodies.rectangle(
                r.left - hr.left + w / 2, r.top - hr.top + h / 2, w, h, opts
            ));
        });
        Composite.add(world, staticBodies);
    }

    function measure() {
        const hr = hero.getBoundingClientRect();
        const vr = visual.getBoundingClientRect();
        state.heroW = hr.width;
        state.heroH = hr.height;

        const scale = clamp(vr.width / 420, 0.78, 1);
        const rescaled = Math.abs(scale - state.scale) > 0.01;
        if (rescaled) {
            state.scale = scale;
            state.dims = { w: 210 * scale, h: 170 * scale, d: 150 * scale, f: 68 * scale };
            applyDims();
        }

        const vx = vr.left - hr.left, vy = vr.top - hr.top;
        state.home = { x: vx + vr.width / 2, y: vy + vr.height / 2 + state.dims.f * 0.2 };
        // The box can wander anywhere within the hero
        state.zone = { left: 0, right: state.heroW, top: 0, bottom: state.heroH };

        if (!box) {
            buildBox(state.home);
        } else if (rescaled) {
            const o = boxOrigin();
            Composite.remove(world, box);
            buildBox(o);
        }
        rebuildStatics(hr);
    }

    /* ---------- logos ---------- */
    function createLogos() {
        TOOLS.forEach(src => {
            const name = src.split('/').pop().replace('.svg', '');
            const el = document.createElement('div');
            el.className = name === 'xlogo' ? 'phys-logo phys-logo--x' : 'phys-logo';
            el.style.setProperty('--icon', `url('${src}')`);
            el.appendChild(document.createElement('i'));
            logoLayer.appendChild(el);

            const body = Bodies.rectangle(0, 0, LOGO_SIZE, LOGO_SIZE, {
                label: name,
                chamfer: { radius: LOGO_SIZE * 0.28 },
                density: 0.0015,
                friction: 0.3,
                frictionAir: 0.012,
                restitution: 0.35,
                collisionFilter: { group: 0, category: CAT_LOGO, mask: CAT_BOX | CAT_LOGO | CAT_STATIC }
            });
            logos.push({ el, body });
        });
        Composite.add(world, logos.map(l => l.body));
    }

    function placeLogo(logo, local) {
        const o = boxOrigin();
        const p = rotate(local, box.angle);
        Body.setPosition(logo.body, { x: o.x + p.x, y: Math.max(o.y + p.y, CEILING + 60) });
        Body.setAngle(logo.body, (Math.random() - 0.5) * 0.6);
        Body.setVelocity(logo.body, { x: 0, y: 0 });
        Body.setAngularVelocity(logo.body, 0);
    }

    // dropIn: stack them above the opening so they fall back in; otherwise settle inside
    function packLogos(dropIn) {
        if (drag && drag.type === 'logo') endDrag();
        const { w, h } = state.dims;
        const cols = 3, gapX = w / cols;
        logos.forEach((logo, i) => {
            const col = i % cols, row = Math.floor(i / cols);
            const x = (col - (cols - 1) / 2) * gapX + (Math.random() - 0.5) * 6;
            const y = dropIn
                ? -h / 2 - LOGO_SIZE - row * (LOGO_SIZE + 16) - i * 4
                : h / 2 - LOGO_SIZE / 2 - 4 - row * (LOGO_SIZE + 6);
            placeLogo(logo, { x, y });
        });
    }

    function guardLogos() {
        const W = state.heroW, H = state.heroH;
        for (const logo of logos) {
            const b = logo.body;
            const speed = Body.getSpeed(b);
            if (speed > MAX_LOGO_SPEED) {
                const v = Body.getVelocity(b);
                Body.setVelocity(b, { x: v.x * MAX_LOGO_SPEED / speed, y: v.y * MAX_LOGO_SPEED / speed });
            }
            // Safety net: anything that escapes the hero gets dropped back into the box
            const p = b.position;
            if (p.y > H + 80 || p.x < -80 || p.x > W + 80 || p.y < CEILING - 100) {
                if (drag && drag.logo === logo) endDrag();
                placeLogo(logo, { x: (Math.random() - 0.5) * state.dims.w * 0.5, y: -state.dims.h / 2 - 60 });
            }
        }
    }

    function updateSpill() {
        const { w, h } = state.dims;
        const outside = logos.some(({ body }) => {
            const l = toBoxLocal(body.position);
            return Math.abs(l.x) > w / 2 || l.y < -h / 2 - LOGO_SIZE * 0.5 || l.y > h / 2;
        });
        if (outside !== spilled) {
            spilled = outside;
            hud.classList.toggle('is-spilled', spilled);
            hero.classList.toggle('is-spilled', spilled);
        }
    }

    /* ---------- pointer interaction ---------- */
    function localPoint(e) {
        const r = hero.getBoundingClientRect();
        return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    function insideBox(p) {
        const { w, h, f } = state.dims;
        const l = toBoxLocal(p);
        return Math.abs(l.x) < w / 2 + WALL && l.y > -h / 2 - f * 0.7 && l.y < h / 2 + WALL;
    }

    function hitTest(p) {
        const hit = Query.point(logos.map(l => l.body), p)[0];
        if (hit) return { type: 'logo', logo: logos.find(l => l.body === hit) };
        if (insideBox(p)) return { type: 'box' };
        return null;
    }

    function setHover(logo, grabbable) {
        hero.classList.toggle('is-grab', grabbable);
        if (hoverLogo === logo) return;
        if (hoverLogo) hoverLogo.el.classList.remove('is-hover');
        hoverLogo = logo;
        if (hoverLogo) hoverLogo.el.classList.add('is-hover');
    }

    function endDrag() {
        if (!drag) return;
        if (drag.type === 'logo') {
            Composite.remove(world, drag.constraint);
            drag.logo.el.classList.remove('is-held');
        }
        drag = null;
        document.body.classList.remove('is-grabbing');
        setTimeout(() => { suppressClick = false; }, 0);
    }

    hero.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !box) return;
        const p = localPoint(e);
        const hit = hitTest(p);
        if (!hit) return;

        e.preventDefault();
        suppressClick = true; // don't follow a link that sits under a grabbed logo
        pointer.x = p.x;
        pointer.y = p.y;

        if (hit.type === 'logo') {
            const b = hit.logo.body;
            const constraint = Constraint.create({
                pointA: { x: p.x, y: p.y },
                bodyB: b,
                pointB: { x: p.x - b.position.x, y: p.y - b.position.y },
                length: 0,
                stiffness: 0.2,
                damping: 0.1
            });
            Composite.add(world, constraint);
            drag = { type: 'logo', logo: hit.logo, constraint };
            hit.logo.el.classList.add('is-held');
        } else {
            const o = boxOrigin();
            drag = { type: 'box', offset: { x: p.x - o.x, y: p.y - o.y } };
        }
        document.body.classList.add('is-grabbing');
        hud.classList.add('is-used');
        hero.classList.add('is-used');
    }, true);

    window.addEventListener('pointermove', e => {
        if (!box) return;
        const p = localPoint(e);
        pointer.x = p.x;
        pointer.y = p.y;
        if (drag) {
            if (drag.type === 'logo') drag.constraint.pointA = { x: p.x, y: p.y };
            return;
        }
        if (e.pointerType !== 'mouse') return;
        const inHero = p.x >= 0 && p.y >= 0 && p.x <= state.heroW && p.y <= state.heroH;
        const hit = inHero ? hitTest(p) : null;
        setHover(hit && hit.type === 'logo' ? hit.logo : null, !!hit);
    }, { passive: true });

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);

    // Block page scroll on touch while dragging (pointerdown fires before touchstart)
    hero.addEventListener('touchstart', e => { if (drag) e.preventDefault(); }, { passive: false });

    hero.addEventListener('click', e => {
        if (!suppressClick) return;
        e.preventDefault();
        e.stopPropagation();
        suppressClick = false;
    }, true);

    repackBtn.addEventListener('click', () => packLogos(true));

    /* ---------- loop ---------- */
    function render() {
        const o = boxOrigin();
        const t = `translate3d(${o.x}px, ${o.y}px, 0) rotate(${box.angle}rad)`;
        layerBack.style.transform = t;
        layerFront.style.transform = t;

        wobble.x += (clamp(boxVel.x * 1.1, -14, 14) - wobble.x) * 0.18;
        wobble.y += (clamp(boxVel.y * 0.9, -10, 10) - wobble.y) * 0.18;
        const view = `perspective(1100px) rotateX(${VIEW_RX - wobble.y}deg) rotateY(${VIEW_RY + wobble.x}deg)`;
        box3dBack.style.transform = view;
        box3dFront.style.transform = view;

        const half = LOGO_SIZE / 2;
        for (const { el, body } of logos) {
            el.style.transform = `translate3d(${body.position.x - half}px, ${body.position.y - half}px, 0) rotate(${body.angle}rad)`;
        }
    }

    function step() {
        driveBox();
        Engine.update(engine, DT);
        guardLogos();
    }

    let rafId = 0, last = 0, acc = 0;
    function frame(now) {
        rafId = requestAnimationFrame(frame);
        acc += Math.min(now - last, 50);
        last = now;
        let steps = 0;
        while (acc >= DT && steps < 5) {
            step();
            acc -= DT;
            steps++;
        }
        if (++frameCount % 20 === 0) updateSpill();
        render();
    }

    function start() {
        if (rafId) return;
        last = performance.now();
        acc = 0;
        rafId = requestAnimationFrame(frame);
    }

    function stop() {
        cancelAnimationFrame(rafId);
        rafId = 0;
        endDrag();
    }

    /* ---------- boot ---------- */
    measure();
    createLogos();
    packLogos(false);
    render();
    stage.classList.add('is-ready');
    hero.classList.add('phys-on');

    // Pause the simulation while the hero is off-screen
    new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop())).observe(hero);

    // Re-measure colliders once the copy has finished its intro slide and fonts are in
    let resizeTimer = 0;
    const remeasure = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(measure, 120); };
    new ResizeObserver(remeasure).observe(hero);
    const ctas = hero.querySelector('.hero-ctas');
    if (ctas) ctas.addEventListener('animationend', remeasure);
    if (document.fonts) document.fonts.ready.then(remeasure);
    setTimeout(remeasure, 1300);

    // A little hop once it fades in, hinting that it's alive
    if (!reduceMotion) setTimeout(() => { if (!drag) boxVel.y = -3; }, 1800);
})();
