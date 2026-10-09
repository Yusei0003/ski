// OpenStreetMap (Overpass API) への問い合わせ内容。
// ブラウザ (app.js) とデータ更新スクリプト (scripts/fetch-osm-data.mjs) の両方で使う。
window.OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

// bbox は [南, 西, 北, 東]
window.buildOsmQuery = function (bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:120];
(
  way["piste:type"="downhill"](${b});
  way["aerialway"~"^(cable_car|gondola|mixed_lift|chair_lift|drag_lift|t-bar|j-bar|platter|rope_tow|magic_carpet)$"](${b});
  way["landuse"="winter_sports"](${b});
  relation["landuse"="winter_sports"](${b});
);
out geom;`;
};
