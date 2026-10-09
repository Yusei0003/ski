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

// 建物と施設 (リフト乗り場・レストランなど) の問い合わせ。resorts.js で buildings: true のエリアだけ取得する。
window.buildBuildingQuery = function (bbox) {
  const b = bbox.join(',');
  return `[out:json][timeout:180];
(
  way["building"](${b});
  relation["building"](${b});
  way["building:part"](${b});
  nwr["aerialway"="station"](${b});
  nwr["amenity"~"^(restaurant|cafe|fast_food|food_court|bar|pub|toilets|first_aid|clinic|information|parking|ticket_validator)$"](${b});
  nwr["tourism"~"^(hotel|information|alpine_hut|guest_house|chalet|hostel)$"](${b});
  nwr["shop"](${b});
);
out geom;`;
};
