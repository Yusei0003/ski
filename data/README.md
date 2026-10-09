# data/

GitHub Actions(`.github/workflows/update-osm-data.yml`)が週1回、OpenStreetMap から取得したスキー場のコース・リフトのデータを `<エリアID>.js` として保存するフォルダです(ファイルを直接開いても読めるよう、JSON ではなく JavaScript の形式)。
アプリはまずここのファイルを読み、無い場合だけ Overpass API から直接取得します。

データ © OpenStreetMap contributors(ODbL ライセンス)
