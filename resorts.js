// 表示するエリア(スキー場群)の定義。
// bbox は [南, 西, 北, 東]。OpenStreetMap からこの範囲のコース・リフト・スキー場の範囲を取得する。
//
// areas はエリア内の個々のスキー場。
//   match  … OpenStreetMap のスキー場範囲 (landuse=winter_sports) の名前と照合する正規表現
//   center … OSM に範囲が無いときの代わりの位置 (おおよその座標)
// landmarks は「写真と比べる」で向きを合わせる目印の山 (lngLat: [経度, 緯度], elevation: 標高m, 位置はおおよそ)
//
//   lifts  … (任意) リフト名と照合する正規表現。OSM の範囲が複数のスキー場をまとめて囲んでいる場合
//            (ニセコユナイテッドなど)、名前で振り分けたリフトに一番近いスキー場へコースを割り当てる
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
      { name: '白馬コルチナスキー場', match: /コルチナ|cortina/i, center: [137.882, 36.779] },
      { name: '白馬乗鞍温泉スキー場', match: /乗鞍|norikura/i, center: [137.87, 36.77] },
      { name: '栂池高原スキー場', match: /栂池|tsugaike/i, center: [137.85, 36.755] },
      { name: '白馬岩岳スノーフィールド', match: /岩岳|iwatake/i, center: [137.845, 36.725] },
      { name: '白馬八方尾根スキー場', match: /八方|happo/i, center: [137.818, 36.704] },
      { name: 'Hakuba47', match: /47/, center: [137.82, 36.675] },
      { name: 'エイブル白馬五竜', match: /五竜|goryu/i, center: [137.825, 36.664] },
      { name: '白馬さのさかスキー場', match: /さのさか|佐野坂|sanosaka/i, center: [137.836, 36.623] },
      { name: '鹿島槍スキー場', match: /鹿島槍|kashimayari/i, center: [137.829, 36.6] },
      { name: '爺ガ岳スキー場', match: /爺|jiigatake/i, center: [137.798, 36.56] },
    ],
    landmarks: [
      { name: '白馬岳', lngLat: [137.7584, 36.7584], elevation: 2932 },
      { name: '唐松岳', lngLat: [137.7547, 36.6855], elevation: 2696 },
      { name: '五竜岳', lngLat: [137.7528, 36.6583], elevation: 2814 },
      { name: '鹿島槍ヶ岳', lngLat: [137.7472, 36.6247], elevation: 2889 },
    ],
  },
  {
    id: 'niseko',
    name: 'ニセコ',
    sub: '北海道 / ニセコユナイテッド・モイワ',
    center: [140.68, 42.87],
    bbox: [42.83, 140.6, 42.91, 140.74],
    areas: [
      // OSM ではユナイテッドの4スキー場が1つの範囲にまとまっているので、リフト名で振り分ける
      { name: 'ニセコHANAZONOリゾート', match: /花園|hanazono/i, center: [140.69, 42.885], lifts: /花園|hanazono/i },
      {
        name: 'ニセコグラン・ヒラフ',
        match: /ひらふ|ヒラフ|hirafu/i,
        center: [140.685, 42.867],
        lifts: /エース|キング|スインギング|ホリデー|ace|king|swinging|holiday/i,
      },
      {
        name: 'ニセコビレッジ',
        match: /ビレッジ|village/i,
        center: [140.675, 42.85],
        lifts: /ビレッジ|ワンダーランド|カントリーロード|バンザイ|森の|コミュニティ|^ニセコゴンドラ|village|wonderland|banzai|mori|community/i,
      },
      {
        name: 'ニセコアンヌプリ国際',
        match: /アンヌプリ国際|annupuri international/i,
        center: [140.652, 42.855],
        lifts: /ジャンボ|ドリーム|アンヌプリゴンドラ|jumbo|dream|annupuri/i,
      },
      { name: 'ニセコモイワ', match: /モイワ|moiwa/i, center: [140.63, 42.853] },
    ],
    landmarks: [
      { name: '羊蹄山', lngLat: [140.8114, 42.8267], elevation: 1898 },
      { name: 'ニセコアンヌプリ', lngLat: [140.6564, 42.8753], elevation: 1308 },
    ],
  },
  {
    id: 'appi',
    name: '安比高原',
    sub: '岩手県八幡平市',
    center: [140.98, 39.95],
    bbox: [39.9, 140.92, 40.01, 141.05],
    buildings: true, // 建物を立体表示する (data/appi-buildings.js)
    areas: [{ name: '安比高原スキー場', match: /安比|appi/i, center: [140.98, 39.95] }],
    landmarks: [
      { name: '岩手山', lngLat: [141.0011, 39.8522], elevation: 2038 },
      { name: '八幡平', lngLat: [140.8542, 39.9578], elevation: 1613 },
    ],
  },
];
