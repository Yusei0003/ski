# data/

GitHub Actions(`.github/workflows/update-osm-data.yml`)が週1回、OpenStreetMap から取得したスキー場のコース・リフトのデータを `<エリアID>.json` として保存するフォルダです。
アプリはまずここのファイルを読み、無い場合だけ Overpass API から直接取得します。

データ © OpenStreetMap contributors(ODbL ライセンス)
