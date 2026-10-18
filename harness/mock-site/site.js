document.querySelectorAll('.preFade').forEach(e=>{new IntersectionObserver(([x])=>{if(x.isIntersecting)e.classList.add('fadeIn')}).observe(e)});
document.querySelector('.header-burger-btn').onclick=()=>document.body.classList.toggle('header--menu-open');
const imgs=[...document.querySelectorAll('.gallery img')];let i=0;imgs[0].classList.add('active');
document.querySelector('[data-next]').onclick=()=>{imgs[i].classList.remove('active');i=(i+1)%imgs.length;imgs[i].classList.add('active')};
document.querySelectorAll('img[data-src]').forEach(im=>im.src=im.dataset.src);
