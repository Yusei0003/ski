// 表示するエリア(スキー場群)の定義。
// bbox は [南, 西, 北, 東]。OpenStreetMap からこの範囲のコース・リフト・スキー場の範囲を取得する。
//
// areas はエリア内の個々のスキー場。
//   match  … OpenStreetMap のスキー場範囲 (landuse=winter_sports) の名前と照合する正規表現
//   center … OSM に範囲が無いときの代わりの位置 (おおよその座標)
// OSM 上でここに無い名前付きのスキー場が見つかった場合は、その名前で自動的に追加される。
// 新しいエリアはここに追加すれば一覧に表示される。
window.RESORTS = [
  {
    id: 'hakuba',
    name: '白馬バレー',
    sub: '長野県 / 白馬村・小谷村・大町市の10スキー場',
    center: [137.82, 36.68],
    bbox: [36.54, 137.73, 36.82, 137.91],
    areas: [
      { name: '白馬コルチナスキー場', match: /コルチナ|cortina/i, center: [137.815, 36.787] },
      { name: '白馬乗鞍温泉スキー場', match: /乗鞍|norikura/i, center: [137.832, 36.776] },
      { name: '栂池高原スキー場', match: /栂池|tsugaike/i, center: [137.83, 36.764] },
      { name: '白馬岩岳スノーフィールド', match: /岩岳|iwatake/i, center: [137.855, 36.716] },
      { name: '白馬八方尾根スキー場', match: /八方|happo/i, center: [137.825, 36.699] },
      { name: 'Hakuba47', match: /47/, center: [137.808, 36.663] },
      { name: 'エイブル白馬五竜', match: /五竜|goryu/i, center: [137.826, 36.667] },
      { name: '白馬さのさかスキー場', match: /さのさか|佐野坂|sanosaka/i, center: [137.83, 36.625] },
      { name: '鹿島槍スキー場', match: /鹿島槍|kashimayari/i, center: [137.81, 36.592] },
      { name: '爺ガ岳スキー場', match: /爺|jiigatake/i, center: [137.8, 36.566] },
    ],
  },
  {
    id: 'niseko',
    name: 'ニセコ',
    sub: '北海道 / ニセコユナイテッド・モイワ',
    center: [140.68, 42.87],
    bbox: [42.83, 140.6, 42.91, 140.74],
    areas: [
      { name: 'ニセコ花園', match: /花園|hanazono/i, center: [140.715, 42.885] },
      { name: 'ニセコグラン・ヒラフ', match: /ひらふ|ヒラフ|hirafu/i, center: [140.7, 42.862] },
      { name: 'ニセコビレッジ', match: /ビレッジ|village/i, center: [140.672, 42.852] },
      { name: 'ニセコアンヌプリ国際', match: /アンヌプリ国際|annupuri/i, center: [140.65, 42.852] },
      { name: 'ニセコモイワ', match: /モイワ|moiwa/i, center: [140.62, 42.86] },
    ],
  },
  {
    id: 'appi',
    name: '安比高原',
    sub: '岩手県八幡平市',
    center: [140.98, 39.95],
    bbox: [39.9, 140.92, 40.01, 141.05],
    areas: [{ name: '安比高原スキー場', match: /安比|appi/i, center: [140.98, 39.95] }],
  },
];
