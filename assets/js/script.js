'use strict';



const sections = [...document.querySelectorAll('main > section[id]')];
const dots = [...document.querySelectorAll('.dot')];



// the active section is the last one whose top has passed 40% of the viewport
const setActiveDot = function () {
  const line = innerHeight * 0.4;
  let current = 0;

  sections.forEach(function (section, i) {
    if (section.getBoundingClientRect().top <= line) current = i;
  });

  dots.forEach(function (dot, i) {
    dot.classList.toggle('is-active', i === current);
    if (i === current) dot.setAttribute('aria-current', 'true');
    else dot.removeAttribute('aria-current');
  });
};

let ticking = false;

addEventListener('scroll', function () {
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(function () { setActiveDot(); ticking = false; });
}, { passive: true });

addEventListener('resize', setActiveDot);
setActiveDot();
