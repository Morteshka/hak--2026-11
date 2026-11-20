const tempMaps = (() => {
  const center = [47.223, 39.722];
  const key = document.querySelector('meta[name="yandex-maps-key"]').content;
  let sdk;
  function loadSdk() {
    if (!key) return Promise.resolve(null);
    if (!sdk) sdk = new Promise(resolve => {
      const script = document.createElement('script');
      const timer = setTimeout(() => resolve(null), 8000);
      function finish(value) { clearTimeout(timer); resolve(value); }
      script.src = 'https://api-maps.yandex.ru/2.1.79/?' + new URLSearchParams({apikey:key,lang:'ru_RU',csp:'true'});
      script.onerror = () => finish(null);
      script.onload = () => window.ymaps?.ready(() => finish(window.ymaps));
      document.head.append(script);
    });
    return sdk;
  }
  function address(coords, embed, zoom=16) {
    const ll = [coords[1],coords[0]].join(',');
    const url = new URL(embed?'https://yandex.ru/map-widget/v1/':'https://yandex.ru/maps/');
    url.search = new URLSearchParams({ll,pt:ll+',pm2rdm',z:zoom,l:'map'});
    return url.href;
  }
  function widget(box, coords, title) {
    const frame=document.createElement('iframe');
    frame.title='Яндекс Карты · '+title;
    frame.src=address(coords,true);
    frame.allowFullscreen=true;
    box.replaceChildren(frame);
  }
  function externalLink(coords, route=false) {
    const a=document.createElement('a');
    a.className='link';a.target='_blank';a.rel='noopener noreferrer';
    a.textContent=route?'Построить маршрут':'Открыть в Яндекс Картах';
    a.href=route?'https://yandex.ru/maps/?'+new URLSearchParams({rtext:'~'+coords.join(','),rtt:'pd'}):address(coords,false);
    return a;
  }
  async function show(box, events, catalogue=false) {
    if (!events.length) {box.remove();return;}
    const first=events[0], coords=[first.lat, first.lng];
    const tools=document.createElement('div');tools.className='map-tools';
    box.after(tools);
    const ym=await loadSdk();
    if (!box.isConnected) return;
    if (ym) {
      try {
        const map=new ym.Map(box,{center:coords,zoom:15,controls:['zoomControl']});
        for(const event of events){
          const text=document.createElement('a');text.href='/events/'+event.id;text.textContent=event.title;
          map.geoObjects.add(new ym.Placemark([event.lat,event.lng],{balloonContent:text.outerHTML}));
        }
        if(events.length>1) map.setBounds(map.geoObjects.getBounds(),{checkZoomRange:true,zoomMargin:32});
        if(!catalogue)tools.append(externalLink(coords),externalLink(coords,true));
        return;
      } catch {box.replaceChildren();}
    }
    const links=document.createElement('div');links.className='actions';
    let current=events, backup;
    const toggle=document.createElement('button');
    toggle.type='button';toggle.className='btn light';toggle.textContent='Резервная карта';
    function resetBackup(){
      if(backup){backup.remove();backup=null;}
      toggle.textContent='Резервная карта';
    }
    toggle.onclick=()=>{
      if(backup){resetBackup();if(current.length===1)selectEvent(current[0]);else tools.querySelector('select').onchange();return;}
      box.replaceChildren();
      backup=L.map(box).setView([current[0].lat,current[0].lng],15);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(backup);
      const points=current.map(e=>{
        const point=[e.lat,e.lng],link=document.createElement('a');
        link.href='/events/'+e.id;link.textContent=e.title;
        L.marker(point).addTo(backup).bindPopup(link);
        return point;
      });
      if(points.length>1)backup.fitBounds(points,{padding:[28,28],maxZoom:16});
      toggle.textContent='Вернуться в Яндекс Карты';
    };
    function selectEvent(e) {
      resetBackup();current=[e];
      const point=[e.lat,e.lng];
      widget(box,point,e.title);
      links.replaceChildren(externalLink(point),externalLink(point,true),toggle);
      if(catalogue) {
        const a=document.createElement('a');a.className='link';a.href='/events/'+e.id;a.textContent='Карточка события';links.append(a);
      }
    }
    if(catalogue){
      const label=document.createElement('label'), select=document.createElement('select');
      label.textContent='Показать событие на карте';
      select.add(new Option('Все события','all'));
      events.forEach((e,i)=>select.add(new Option(e.title,String(i))));
      function overview(){
        resetBackup();current=events;
        const xs=events.map(e=>e.lng), ys=events.map(e=>e.lat);
        const west=Math.min(...xs), east=Math.max(...xs), south=Math.min(...ys), north=Math.max(...ys);
        const middle=[(south+north)/2,(west+east)/2];
        const extent=Math.max((east-west)/Math.max(240,box.clientWidth-60),(north-south)/Math.max(160,box.clientHeight-60)/0.68);
        const zoom=Math.min(15,Math.max(9,Math.floor(Math.log2(360/(256*extent)))));
        const frame=document.createElement('iframe');frame.title='Яндекс Карты · события Ростова';
        const url=new URL(address(middle,true,zoom));
        url.searchParams.set('pt',events.map(e=>[e.lng,e.lat,'pm2rdm'].join(',')).join('~'));
        frame.src=url.href;box.replaceChildren(frame);
        const full=externalLink(middle);
        const fullUrl=new URL('https://yandex.ru/maps/');fullUrl.search=url.search;full.href=fullUrl.href;
        links.replaceChildren(full,toggle);
      }
      select.onchange=()=>select.value==='all'?overview():selectEvent(events[Number(select.value)]);
      label.append(select);tools.append(label);
      tools.append(links);overview();return;
    }
    tools.append(links);selectEvent(first);
  }
  async function pick(box, lat, lng) {
    const ym=await loadSdk();if(!box.isConnected)return;
    const coords=()=>[lat.valueAsNumber,lng.valueAsNumber];
    const valid=()=>lat.value!==''&&lng.value!==''&&lat.validity.valid&&lng.validity.valid;
    function write(point) { lat.value=point[0].toFixed(6);lng.value=point[1].toFixed(6); }
    const at=valid()?coords():center;
    if(ym) {
      try {
        const map=new ym.Map(box,{center:at,zoom:13,controls:['zoomControl']});
        const pin=new ym.Placemark(at,{}, {draggable:true});map.geoObjects.add(pin);
        map.events.add('click',e=>{const p=e.get('coords');pin.geometry.setCoordinates(p);write(p);});
        pin.events.add('dragend',()=>write(pin.geometry.getCoordinates()));
        const sync=()=>{if(valid()){pin.geometry.setCoordinates(coords());map.setCenter(coords());}};
        lat.addEventListener('change',sync);lng.addEventListener('change',sync);
        return;
      }catch{box.replaceChildren();}
    }
    const preview=document.createElement('details'),summary=document.createElement('summary'),canvas=document.createElement('div');
    summary.textContent='Проверить точку в Яндекс Картах';canvas.className='map';
    preview.append(summary,canvas);box.after(preview);
    const refresh=()=>{if(preview.open&&valid())widget(canvas,coords(),'Место встречи');};
    preview.ontoggle=refresh;
    const m=L.map(box).setView(at,13);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19, attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'}).addTo(m);
    const pin=L.marker(at,{draggable:true}).addTo(m);
    const select=p=>{pin.setLatLng(p);write([p.lat,p.lng]);refresh();};
    m.on('click',e=>select(e.latlng));pin.on('dragend',()=>select(pin.getLatLng()));
    const sync=()=>{if(valid()){pin.setLatLng(coords());m.panTo(coords());refresh();}};
    lat.addEventListener('change',sync);lng.addEventListener('change',sync);
  }
  return {show,pick};
})();
