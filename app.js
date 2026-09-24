/**
 * 気象学習支援サイト - アプリケーションロジック (app.js)
 */

// PDF.js workerの設定
if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js';
}

// アプリケーションのグローバル状態
const state = {
    // 3日間のデータ。各日24時間分の気象レコードの配列
    // 各レコード: { time, temp, windSpeed, windDir, pressure, humidity, weatherCode }
    weatherData: [], 
    dates: [
        { year: 2026, month: 4, day: 1, dow: '水' },
        { year: 2026, month: 4, day: 2, dow: '木' },
        { year: 2026, month: 4, day: 3, dow: '金' }
    ],
    // 3日分の概況説明テキストと天気図画像URL
    dayNotes: [
        { title: "1日目", dateStr: "4月1日(水)", desc: "冬型の気圧配置が続きました。現地気圧はやや低めで推移し、午前中を中心に湿度が高く、弱い雨や霧が発生しました。風速は比較的穏やかでした。", mapSrc: "output/default_chart1.png" },
        { title: "2日目", dateStr: "4月2日(木)", desc: "日中に高気圧に覆われ、湿度が大幅に低下（最小52%）しました。気温は一時的に9.1℃まで上昇し、天気も晴れとなりました。風向は北よりでした。", mapSrc: "output/default_chart2.png" },
        { title: "3日目", dateStr: "4月3日(金)", desc: "気圧が緩やかに上昇し、天候が安定しました。風速が弱まり静穏な状態が続いたため、気温の急激な変化はなく、穏やかな1日となりました。", mapSrc: "output/default_chart3.png" }
    ],
    pageCache: {},
    cropOffsets: [{dx:0, dy:0}, {dx:0, dy:0}, {dx:0, dy:0}],
    // アップロードされたPDFドキュメントの配列
    // 各ドキュメント: { name, year, month, pdfDoc }
    pdfFiles: [],
    cropSettings: [
        { x: 4.7, y: 1.8, w: 94.9, h: 94.2, pad: 2 },
        { x: 4.7, y: 1.8, w: 94.9, h: 94.2, pad: 2 },
        { x: 4.7, y: 1.8, w: 94.9, h: 94.2, pad: 2 }
    ],
    graphSettings: {
        pressMin: 890,
        pressMax: 910,
        tempMin: -5,
        tempMax: 20,
        humMin: 0,
        humMax: 100
    },
    locationName: "軽井沢",
    displayMode: "image", // "text" (天気図のみ/テキスト抽出) もしくは "image" (天気図+説明画像丸ごと)
    extractedImages: {}, // 一括切り出しした全日程の画像 (キー: 日, 値: base64 DataURL)
    isExtracting: false
};

// ==========================================================================
// 1. 起動時の初期化 & ナビゲーション
// ==========================================================================
window.addEventListener('DOMContentLoaded', () => {
    initNavigation();
    initEventListeners();
    initScheduleManager();
    initTopicsLearning();
    initMogiQAManager();
    loadDefaultData();
    updateLocationDisplay();
    setupCanvasDrag();
});

// ポータルタブ切り替え関数
function switchTab(tabId) {
    // 全てのタブパネルを非表示
    document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.classList.remove('active');
    });

    // 全てのナビゲーションボタンのアクティブ状態を解除
    document.querySelectorAll('.nav-tab, .btn-navbar-cta').forEach(btn => {
        btn.classList.remove('active');
    });

    // 指定されたタブパネルを表示
    const targetPanel = document.getElementById(tabId);
    if (targetPanel) {
        targetPanel.classList.add('active');
    }

    // 対応するナビゲーションボタンをアクティブに
    const targetBtn = document.querySelector(`[data-tab="${tabId}"]`);
    if (targetBtn) {
        targetBtn.classList.add('active');
    }

    // URLハッシュを更新
    const hash = tabId.replace('tab-', '');
    if (window.location.hash !== `#${hash}`) {
        window.history.replaceState(null, '', `#${hash}`);
    }

    // 画面上部へスクロール（プリント作成ツール以外）
    if (tabId !== 'tab-generator') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}
window.switchTab = switchTab;

// ナビゲーションの初期化とハッシュ連動
function initNavigation() {
    document.querySelectorAll('.nav-tab, .btn-navbar-cta').forEach(btn => {
        btn.addEventListener('click', () => {
            const tabId = btn.getAttribute('data-tab');
            if (tabId) {
                switchTab(tabId);
            }
        });
    });

    window.addEventListener('hashchange', initTabFromHash);
    initTabFromHash();
}

function initTabFromHash() {
    const hash = window.location.hash.replace('#', '');
    const validTabs = ['mission', 'rubric', 'schedule', 'links', 'drive', 'mogi', 'generator'];
    if (hash && validTabs.includes(hash)) {
        switchTab(`tab-${hash}`);
    } else {
        switchTab('tab-mission');
    }
}

// イベントリスナーのセットアップ
function initEventListeners() {
    // CSVファイルの読み込み
    document.getElementById('csv-file').addEventListener('change', handleCsvUpload);

    // カレンダー天気図PDFのアップロード (2枠対応)
    document.getElementById('cal-file-1').addEventListener('change', (e) => handleCalendarPdfUpload(e, 1));
    document.getElementById('cal-file-2').addEventListener('change', (e) => handleCalendarPdfUpload(e, 2));

    // 提出情報の変更反映
    document.getElementById('student-group').addEventListener('input', updateStudentInfo);
    document.getElementById('student-name').addEventListener('input', updateStudentInfo);
}

// 初期デフォルトデータのロード（ワークスペース内の data.csv をフェッチ）
async function loadDefaultData() {
    try {
        const response = await fetch('input/data.csv');
        if (!response.ok) throw new Error('data.csv not found');
        
        // 気象データは通常 Shift_JIS で保存されているため、ArrayBuffer で受け取ってデコードする
        const buffer = await response.arrayBuffer();
        const decoder = new TextDecoder('shift-jis');
        const csvText = decoder.decode(buffer);
        
        parseCsv(csvText);
    } catch (err) {
        console.warn('Default data.csv load failed, waiting for user upload:', err);
    }
}

// 提出用名前情報の反映
function updateStudentInfo() {
    const grp = document.getElementById('student-group').value;
    const name = document.getElementById('student-name').value;

    document.getElementById('print-group').innerText = grp ? `グループ：${grp}` : 'グループ：＿＿＿＿';
    document.getElementById('print-name').innerText = `名前：${name || '＿＿＿＿＿＿＿＿'}`;
}

// 観測地点表示の更新
function updateLocationDisplay() {
    const el = document.getElementById('print-location');
    if (el) {
        el.innerText = state.locationName ? `（観測地点：${state.locationName}）` : "（観測地点：未読込）";
    }
}

// アコーディオンの開閉
function toggleAccordion(id) {
    const el = document.getElementById(id);
    el.classList.toggle('hidden');
}

// ==========================================================================
// 2. CSVデータのパース & 状態への保存
// ==========================================================================
function handleCsvUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('csv-filename').innerText = file.name;

    const reader = new FileReader();
    reader.onload = function(evt) {
        // Shift_JIS で読み込む (FileReader のエンコーディング指定)
        const decoder = new TextDecoder('shift-jis');
        const csvText = decoder.decode(evt.target.result);
        parseCsv(csvText);
    };
    reader.readAsArrayBuffer(file);
}

function parseCsv(text) {
    // 改行で分割
    const lines = text.split(/\r?\n/);
    if (lines.length < 5) {
        alert("CSVデータの行数が足りません。正しい気象庁CSVファイルを指定してください。");
        return;
    }

    // デフォルトインデックス（フォールバック用。A=0, B=1, E=4, G=6, J=9, M=12, P=15）
    let datetimeColIdx = 0;   // A
    let tempColIdx = 1;       // B
    let windSpeedColIdx = 4;  // E
    let windDirColIdx = 6;    // G
    let pressureColIdx = 9;   // J
    let weatherCodeColIdx = 12; // M (天気)
    let humidityColIdx = 15;    // P (湿度)

    // データ開始行を動的に検出（日付フォーマット "YYYY/MM/DD..." もしくは数字で始まっている行）
    let dataStartLineIdx = 6; // デフォルトフォールバック
    for (let i = 0; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length > 0) {
            const dateStr = cols[0].trim();
            if (/^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}/.test(dateStr)) {
                dataStartLineIdx = i;
                break;
            }
        }
    }
    console.log("Data starts at line:", dataStartLineIdx + 1);

    // データ開始行より前のすべての行をスキャンして、ヘッダー項目から列インデックスを自動検出
    let foundDatetime = false, foundTemp = false, foundWindSpeed = false, foundWindDir = false, foundPressure = false, foundHumidity = false, foundWeather = false;

    // 指定された列インデックスが品質情報または均質番号であるかをヘッダー全体からチェックするヘルパー
    function isQualityOrHomogeneity(colIdx) {
        for (let rowIdx = 0; rowIdx < dataStartLineIdx; rowIdx++) {
            if (!lines[rowIdx]) continue;
            const cols = lines[rowIdx].split(',').map(c => c.trim().replace(/[\"\']/g, ""));
            if (colIdx < cols.length) {
                const colText = cols[colIdx];
                if (colText.includes("品質情報") || colText.includes("均質番号")) {
                    return true;
                }
            }
        }
        return false;
    }

    // 1巡目：具体的な単位や記号を含むキーワードで検索 (全半角の表記揺れに対応)
    for (let i = 0; i < dataStartLineIdx; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/[\"\']/g, ""));
        for (let colIdx = 0; colIdx < cols.length; colIdx++) {
            const colText = cols[colIdx];
            if (!colText) continue;

            // 品質情報や均質番号の列はデータ列ではないので絶対にスキップ
            if (colText.includes("品質情報") || colText.includes("均質番号") || isQualityOrHomogeneity(colIdx)) {
                continue;
            }

            if (!foundDatetime && (colText.includes("時間") || colText.includes("時刻") || colText.includes("年月"))) {
                datetimeColIdx = colIdx;
                foundDatetime = true;
            } else if (!foundTemp && (colText.includes("気温(℃)") || colText.includes("気温（℃）"))) {
                tempColIdx = colIdx;
                foundTemp = true;
            } else if (!foundWindSpeed && (colText.includes("風速(m/s)") || colText.includes("風速（m/s）"))) {
                windSpeedColIdx = colIdx;
                foundWindSpeed = true;
            } else if (!foundWindDir && (colText === "風向" || colText === "風向（16方位）" || colText === "風向(16方位)")) {
                windDirColIdx = colIdx;
                foundWindDir = true;
            } else if (!foundPressure && (colText.includes("現地気圧(hPa)") || colText.includes("現地気圧（hPa）"))) {
                pressureColIdx = colIdx;
                foundPressure = true;
            } else if (!foundHumidity && (colText.includes("相対湿度(％)") || colText.includes("相対湿度(%)") || colText.includes("相対湿度（％）") || colText.includes("相対湿度（%）"))) {
                humidityColIdx = colIdx;
                foundHumidity = true;
            } else if (!foundWeather && colText === "天気") {
                weatherCodeColIdx = colIdx;
                foundWeather = true;
            }
        }
    }

    // 2巡目：見つからなかった項目をより曖昧なキーワードで補完
    for (let i = 0; i < dataStartLineIdx; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/[\"\']/g, ""));
        for (let colIdx = 0; colIdx < cols.length; colIdx++) {
            const colText = cols[colIdx];
            if (!colText) continue;

            if (colText.includes("品質情報") || colText.includes("均質番号") || isQualityOrHomogeneity(colIdx)) {
                continue;
            }

            if (!foundTemp && colText.includes("気温")) {
                tempColIdx = colIdx;
                foundTemp = true;
            } else if (!foundWindSpeed && colText.includes("風速")) {
                windSpeedColIdx = colIdx;
                foundWindSpeed = true;
            } else if (!foundWindDir && colText.includes("風向")) {
                windDirColIdx = colIdx;
                foundWindDir = true;
            } else if (!foundPressure && (colText.includes("現地気圧") || colText.includes("気圧"))) {
                pressureColIdx = colIdx;
                foundPressure = true;
            } else if (!foundHumidity && (colText.includes("相対湿度") || colText.includes("湿度"))) {
                humidityColIdx = colIdx;
                foundHumidity = true;
            } else if (!foundWeather && colText.includes("天気")) {
                weatherCodeColIdx = colIdx;
                foundWeather = true;
            }
        }
    }

    console.log("Detected Columns Info:", {
        datetimeColIdx, datetimeFound: foundDatetime,
        tempColIdx, tempFound: foundTemp,
        windSpeedColIdx, windSpeedFound: foundWindSpeed,
        windDirColIdx, windDirFound: foundWindDir,
        pressureColIdx, pressureFound: foundPressure,
        humidityColIdx, humidityFound: foundHumidity,
        weatherCodeColIdx, weatherFound: foundWeather
    });

    const records = [];
    const maxIdx = Math.max(datetimeColIdx, tempColIdx, windSpeedColIdx, windDirColIdx, pressureColIdx, humidityColIdx, weatherCodeColIdx);
    
    for (let i = dataStartLineIdx; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const cols = line.split(',');
        if (cols.length <= maxIdx) continue;

        const getCleanFloat = (val) => {
            if (!val) return NaN;
            const clean = val.trim().replace(/[\"\']/g, "");
            return parseFloat(clean);
        };

        const datetimeStr = cols[datetimeColIdx] ? cols[datetimeColIdx].trim().replace(/[\"\']/g, "") : "";
        const temp = getCleanFloat(cols[tempColIdx]);
        const windSpeed = getCleanFloat(cols[windSpeedColIdx]);
        const windDir = cols[windDirColIdx] ? cols[windDirColIdx].trim().replace(/[\"\']/g, "") : "";
        const pressure = getCleanFloat(cols[pressureColIdx]);
        
        let humidity = getCleanFloat(cols[humidityColIdx]);
        // 湿度正規化：もし値が 0〜1 の範囲の小数である場合は100倍して0〜100%にする
        if (!isNaN(humidity) && humidity > 0 && humidity <= 1.0) {
            humidity = humidity * 100;
        }

        const weatherCode = parseInt(cols[weatherCodeColIdx]) || 0;

        records.push({
            datetime: datetimeStr,
            temp,
            windSpeed,
            windDir,
            pressure,
            humidity,
            weatherCode
        });
    }

    if (records.length === 0) {
        alert("有効な気象データが見つかりませんでした。");
        return;
    }

    // 3日分（72時間分）を抽出
    state.weatherData = records.slice(0, 72);

    // 地点名の自動検出（3行目の2番目の列を取得）
    let locationName = "";
    if (lines.length > 2) {
        const cols = lines[2].split(',');
        if (cols.length > 1 && cols[1].trim()) {
            locationName = cols[1].trim().replace(/[\"\']/g, "");
            locationName = locationName.replace(/^ダウンロードした地点：/, "").replace(/^地点：/, "");
        }
    }
    state.locationName = locationName || "CSV観測地点";
    updateLocationDisplay();
    setupCanvasDrag();

    // 縦軸範囲の自動調整
    adjustGraphAxes();

    // 日付を抽出してタイトルに反映
    extractDatesFromData();
    
    // グラフの描画
    drawGraphs();
    
    // 天気図自動レンダリングの再実行
    renderAllWeatherCharts();
}

// 読み込んだデータから気温・湿度・気圧の最小値・最大値を取得し、グラフの縦軸を自動調整する
function adjustGraphAxes() {
    if (state.weatherData.length === 0) return;

    const temps = state.weatherData.map(r => r.temp).filter(v => !isNaN(v));
    const humidities = state.weatherData.map(r => r.humidity).filter(v => !isNaN(v));
    const pressures = state.weatherData.map(r => r.pressure).filter(v => !isNaN(v));

    // 1. 気温の自動調整 (5℃刻み、マージン上下2℃)
    if (temps.length > 0) {
        const minT = Math.min(...temps);
        const maxT = Math.max(...temps);
        let tempMin = Math.floor((minT - 2) / 5) * 5;
        let tempMax = Math.ceil((maxT + 2) / 5) * 5;
        if (tempMax - tempMin < 10) {
            tempMax = tempMin + 10;
        }
        state.graphSettings.tempMin = tempMin;
        state.graphSettings.tempMax = tempMax;
    }

    // 2. 湿度の自動調整 (10%刻み、マージン上下5%、範囲0〜100%)
    if (humidities.length > 0) {
        const minH = Math.min(...humidities);
        const maxH = Math.max(...humidities);
        let humMin = Math.max(0, Math.floor((minH - 5) / 10) * 10);
        let humMax = Math.min(100, Math.ceil((maxH + 5) / 10) * 10);
        if (humMax - humMin < 20) {
            if (humMax === 100) {
                humMin = 80;
            } else if (humMin === 0) {
                humMax = 20;
            } else {
                humMax = humMin + 20;
            }
        }
        state.graphSettings.humMin = humMin;
        state.graphSettings.humMax = humMax;
    }

    // 3. 気圧の自動調整 (10 hPa刻み、マージン上下2 hPa)
    if (pressures.length > 0) {
        const minP = Math.min(...pressures);
        const maxP = Math.max(...pressures);
        let pressMin = Math.floor((minP - 2) / 10) * 10;
        let pressMax = Math.ceil((maxP + 2) / 10) * 10;
        if (pressMax - pressMin < 20) {
            pressMax = pressMin + 20;
        }
        state.graphSettings.pressMin = pressMin;
        state.graphSettings.pressMax = pressMax;

        // UI側の入力欄（コントロールパネル）にも反映する
        const elMin = document.getElementById('press-min');
        const elMax = document.getElementById('press-max');
        if (elMin) elMin.value = pressMin;
        if (elMax) elMax.value = pressMax;
    }
}

// 読み込んだデータから日付（年/月/日）を自動取得し、状態に反映
function extractDatesFromData() {
    if (state.weatherData.length === 0) return;
    
    const uniqueDates = [];
    state.weatherData.forEach(r => {
        // datetime "2026/4/1 1:00:00" から日付部分を抽出
        const datePart = r.datetime.split(' ')[0]; // "2026/4/1"
        if (!uniqueDates.includes(datePart)) {
            uniqueDates.push(datePart);
        }
    });

    // 曜日判定用のマッピング
    const dows = ['日', '月', '火', '水', '木', '金', '土'];

    // 検出された最初から3日分を使用
    for (let i = 0; i < 3; i++) {
        if (uniqueDates[i]) {
            const parts = uniqueDates[i].split('/');
            const dateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            state.dates[i] = {
                year: dateObj.getFullYear(),
                month: dateObj.getMonth() + 1,
                day: dateObj.getDate(),
                dow: dows[dateObj.getDay()]
            };
            
            // プレビューの日付ヘッダーの文字を更新
            document.getElementById(`chart-month-${i+1}`).innerText = state.dates[i].month;
            document.getElementById(`chart-day-${i+1}`).innerText = state.dates[i].day;
            
            // デフォルトの編集用日付ストリングも更新
            state.dayNotes[i].dateStr = `${state.dates[i].month}月${state.dates[i].day}日(${state.dates[i].dow})`;
        }
    }
    
    updatePreviewTexts();
}

// プレビュー画面のテキストを全更新
function updatePreviewTexts() {
    for (let i = 0; i < 3; i++) {
        const note = state.dayNotes[i];
        
        // タイトル（最初の太字部分）の表示
        if (note.titleText) {
            document.getElementById(`desc-title-${i+1}`).innerText = note.titleText;
        } else {
            document.getElementById(`desc-title-${i+1}`).innerText = note.dateStr;
        }

        // 本文（説明文）の表示
        if (note.bodyText) {
            document.getElementById(`desc-body-${i+1}`).innerText = note.bodyText;
        } else {
            document.getElementById(`desc-body-${i+1}`).innerText = note.desc;
        }
    }
}

// ==========================================================================
// 3. カレンダーPDFからの自動天気図抽出 (PDF Rendering)
// ==========================================================================

// ファイル名から「年」と「月」を抽出するヘルパー
function getYearMonthFromFileName(fileName) {
    const cleaned = fileName.replace(/\.[^/.]+$/, ""); // 拡張子削除
    
    // 4桁+2桁の数字 (例: 202612, 2026_12)
    let match = cleaned.match(/(\d{4})[_-]?(\d{2})/);
    if (match) {
        return { year: parseInt(match[1]), month: parseInt(match[2]) };
    }
    // 2桁+2桁 of 数字 (例: 2612)
    match = cleaned.match(/(?:\D|^)(\d{2})[_-]?(\d{2})(?:\D|$)/);
    if (match) {
        let year = parseInt(match[1]);
        year = year < 100 ? 2000 + year : year; // 2000年代と仮定
        return { year: year, month: parseInt(match[2]) };
    }
    // 「〇月」の表記 (例: "12月", "1月")
    match = cleaned.match(/(\d{1,2})月/);
    if (match) {
        return { year: null, month: parseInt(match[1]) };
    }
    // 単一の数字 (例: "12") -> 1〜12の範囲なら月とみなす
    match = cleaned.match(/(?:\D|^)(\d{1,2})(?:\D|$)/);
    if (match) {
        const m = parseInt(match[1]);
        if (m >= 1 && m <= 12) {
            return { year: null, month: m };
        }
    }
    return null;
}

// カレンダーPDF 1 または 2 のアップロード処理
async function handleCalendarPdfUpload(e, slotNum) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById(`cal-file-${slotNum}-name`).innerText = file.name;

    try {
        const ym = getYearMonthFromFileName(file.name);
        const arrayBuffer = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (evt) => resolve(evt.target.result);
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });

        let pdfDoc = null;
        let isImage = file.type.startsWith('image/');
        
        if (isImage) {
            // 画像の場合は、ダミーの pdfDoc オブジェクトを作成する
            const imgUrl = await new Promise((resolve) => {
                const urlReader = new FileReader();
                urlReader.onload = (evt) => resolve(evt.target.result);
                urlReader.readAsDataURL(file);
            });
            
            const img = new Image();
            img.src = imgUrl;
            await new Promise((resolve) => { img.onload = resolve; });
            
            // 画像から tempCanvas を作成
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = img.width;
            tempCanvas.height = img.height;
            const tempCtx = tempCanvas.getContext('2d');
            tempCtx.drawImage(img, 0, 0);
            
            // キャッシュに直接登録（pageNum = 1 とみなす）
            const cacheKey = `${slotNum}_1`;
            state.pageCache[cacheKey] = tempCanvas;
            
            // ダミーの pdfDoc
            pdfDoc = {
                numPages: 1,
                getPage: async () => ({
                    getViewport: () => ({ width: img.width, height: img.height }),
                    render: () => ({ promise: Promise.resolve() }),
                    getTextContent: async () => ({ items: [] })
                })
            };
        } else {
            const typedarray = new Uint8Array(arrayBuffer);
            pdfDoc = await pdfjsLib.getDocument({ data: typedarray, cMapUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/cmaps/', cMapPacked: true, standardFontDataUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/standard_fonts/', disableFontFace: true }).promise;
        }

        // 既存のスロットがあれば更新、なければ追加
        const pdfInfo = {
            slot: slotNum,
            name: file.name,
            year: ym ? ym.year : null,
            month: ym ? ym.month : null,
            pdfDoc: pdfDoc,
            isImage: isImage
        };

        const existingIdx = state.pdfFiles.findIndex(f => f.slot === slotNum);
        if (existingIdx !== -1) {
            state.pdfFiles[existingIdx] = pdfInfo;
        } else {
            state.pdfFiles.push(pdfInfo);
        }

        console.log(`Loaded PDF into slot ${slotNum}: ${file.name}, year: ${ym?.year}, month: ${ym?.month}`);
        

        
    } catch (err) {
        console.error(`Failed to load PDF into slot ${slotNum}:`, file.name, err);
        alert(`PDFファイル「${file.name}」の読み込みに失敗しました。`);
    }

    // レンダリングを実行
    renderAllWeatherCharts();
}

// すべての天気図をレンダリング
function renderAllWeatherCharts() {
    for (let dayIdx = 0; dayIdx < 3; dayIdx++) {
        renderSingleWeatherChart(dayIdx);
    }
}

// 単一の天気図のレンダリング
async function renderSingleWeatherChart(dayIdx) {
    const dateInfo = state.dates[dayIdx];
    if (!dateInfo) return;

    const targetYear = dateInfo.year;
    const targetMonth = dateInfo.month;
    const targetDay = dateInfo.day;

    const imgEl = document.getElementById(`weather-map-${dayIdx + 1}`);
    const chartItem = imgEl ? imgEl.closest('.chart-item') : null;



    let selectedPdf = null;
    const startMonth = state.dates[0].month;

    // 2. スロット優先ルール：開始月と同じならスロット1、違えばスロット2を優先して探す
    if (targetMonth === startMonth) {
        selectedPdf = state.pdfFiles.find(f => f.slot === 1);
    } else {
        selectedPdf = state.pdfFiles.find(f => f.slot === 2);
    }

    // 3. スロットで見つからなかった場合のみ、年月マッチングを行う
    if (!selectedPdf) {
        if (targetYear) {
            selectedPdf = state.pdfFiles.find(f => f.year === targetYear && f.month === targetMonth);
        }
        if (!selectedPdf) {
            selectedPdf = state.pdfFiles.find(f => f.month === targetMonth);
        }
    }

    // 3. 一致するPDFが全く見つからない、または対象の月と一致しないPDFしかない場合は、誤った月データを表示しないため処理をスキップ
    if (!selectedPdf || (selectedPdf.month !== null && selectedPdf.month !== targetMonth)) {
        return;
    }

    const canvas = document.getElementById(`crop-canvas-${dayIdx + 1}`);
    const ctx = canvas.getContext('2d');

    try {
        const pdfDoc = selectedPdf.pdfDoc;
        
        // 4x4グリッドのどのセル・どのページから切り出すかを決定
        let pageNum = 1;
        let cellIdx = 0;

        if (targetDay >= 1 && targetDay <= 15) {
            pageNum = 1; // 1日〜15日は1ページ目
            cellIdx = targetDay; // 1日=セル1, 15日=セル15（セル0はタイトル）
        } else if (targetDay >= 16 && targetDay <= 31) {
            // 2ページ目が存在する場合は2ページ目を読み込む
            pageNum = pdfDoc.numPages >= 2 ? 2 : 1;
            cellIdx = targetDay - 16; // 16日=セル0, 31日=セル15
        }
        
        // 画像アップロードの場合は1ページしかないので強制的に1にする
        if (selectedPdf.isImage) {
            pageNum = 1;
        }

        if (pageNum < 1 || pageNum > pdfDoc.numPages) {
            console.warn(`Page ${pageNum} is out of range for PDF`);
            return;
        }

        const cacheKey = `${selectedPdf.slot}_${pageNum}`;
        let tempCanvas = state.pageCache[cacheKey];

        if (!tempCanvas) {
            const page = await pdfDoc.getPage(pageNum);
            const scale = 2.5;
            const viewport = page.getViewport({ scale: scale });

            tempCanvas = document.createElement('canvas');
            tempCanvas.width = viewport.width;
            tempCanvas.height = viewport.height;
            const tempCtx = tempCanvas.getContext('2d');

            const renderContext = { canvasContext: tempCtx, viewport: viewport };
            await page.render(renderContext).promise;
            
            state.pageCache[cacheKey] = tempCanvas;
        }

        // キャッシュ情報を保存
        state.cropOffsets[dayIdx].tempCanvas = tempCanvas;
        state.cropOffsets[dayIdx].cellIdx = cellIdx;

        // 4x4グリッドのセルを切り出す (ページの余白マージンを考慮)
        const W = tempCanvas.width;
        const H = tempCanvas.height;

        const settings = state.cropSettings[dayIdx];
        
        const gridX = W * (settings.x / 100);
        const gridY = H * (settings.y / 100);
        const gridW = W * (settings.w / 100);
        const gridH = H * (settings.h / 100);

        const cellW = gridW / 4;
        const cellH = gridH / 4;

        const col = cellIdx % 4;
        const row = Math.floor(cellIdx / 4);

        drawCrop(dayIdx);
        
        // ワークシートのUI表示モード用クラス切り替え
        if (chartItem) {
            if (state.displayMode === "image") {
                chartItem.classList.add('display-mode-image');
            } else {
                chartItem.classList.remove('display-mode-image');
            }
        }
        
        const page = await pdfDoc.getPage(pageNum); // テキスト抽出のためだけにページを取得し直す (非常に軽量)

        // テキストの自動抽出と概況説明欄への流し込み
        try {
            const textContent = await page.getTextContent();
            let pageText = textContent.items.map(item => item.str).join("").trim();
            console.log(`Extracted text for day ${targetDay}:`, pageText);

            // 「DD日(曜)」から始まる部分を探してそれ以降を概況とする
            const dayStrPattern = new RegExp(`${targetDay}日\\([日月火水木金土]\\)`);
            const matchIndex = pageText.search(dayStrPattern);
            if (matchIndex !== -1) {
                let descText = pageText.substring(matchIndex);
                
                // 翌日のテキストの開始位置を探し、そこまででカットする
                const nextDay = targetDay + 1;
                const nextDayPattern = new RegExp(`${nextDay}日\\([日月火水木金土]\\)`);
                const nextDayIndex = descText.search(nextDayPattern);
                if (nextDayIndex !== -1) {
                    descText = descText.substring(0, nextDayIndex).trim();
                }

                // フッター「気象庁」などの不要な部分を削除
                const footerIndex = descText.indexOf("気象庁");
                if (footerIndex !== -1) {
                    descText = descText.substring(0, footerIndex).trim();
                }

                // 改行や連続する空白をクリーンアップ
                descText = descText.replace(/\s+/g, " ").trim();

                // 最初の文（太字タイトル）と次の説明（本文）を分ける
                // 区切りとして「。」「　」（全角スペース）「  」（連続半角スペース）を使用
                const periodIdx = descText.indexOf('。');
                const spaceIdx = descText.indexOf('　');
                const doubleSpaceIdx = descText.indexOf('  ');

                let splitIdx = -1;
                let delimiterLen = 0;

                const indices = [
                    { idx: periodIdx, len: 1 },
                    { idx: spaceIdx, len: 1 },
                    { idx: doubleSpaceIdx, len: 2 }
                ].filter(item => item.idx !== -1);

                if (indices.length > 0) {
                    indices.sort((a, b) => a.idx - b.idx);
                    splitIdx = indices[0].idx;
                    delimiterLen = indices[0].len;
                }

                if (splitIdx !== -1) {
                    // 句点「。」で区切る場合はタイトルに「。」を含める
                    const includeLen = (splitIdx === periodIdx) ? 1 : 0;
                    state.dayNotes[dayIdx].titleText = descText.substring(0, splitIdx + includeLen).trim();
                    state.dayNotes[dayIdx].bodyText = descText.substring(splitIdx + delimiterLen).trim();
                } else {
                    state.dayNotes[dayIdx].titleText = state.dayNotes[dayIdx].dateStr;
                    state.dayNotes[dayIdx].bodyText = descText;
                }

                state.dayNotes[dayIdx].desc = descText;
                updatePreviewTexts();
            }
        } catch (textErr) {
            console.warn("Failed to extract text from PDF page:", textErr);
        }
    } catch (err) {
        console.error(`Failed to render page for day ${targetDay}:`, err);
    }
}


// ==========================================================================
// 5. SVGによる気象グラフ & 気象記号の描画
// ==========================================================================
function drawGraphs() {
    if (state.weatherData.length === 0) return;

    // 上グラフ: 1日目 & 2日目 (時間 0〜48)
    const upperData = state.weatherData.slice(0, 48);
    drawSingleSvgGraph('svg-container-upper', upperData, 0);

    // 下グラフ: 3日目 (時間 48〜72) & 余白
    const lowerData = state.weatherData.slice(48, 72);
    drawSingleSvgGraph('svg-container-lower', lowerData, 1);
}

function drawSingleSvgGraph(containerId, data, graphIdx) {
    const container = document.getElementById(containerId);
    container.innerHTML = ''; // クリア

    const width = 720;
    const height = 260;
    const padding = {
        top: 25,
        right: 75,
        bottom: 75,
        left: 45
    };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // SVGタグ作成
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // グリッド線描画
    const gridGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    gridGroup.setAttribute('stroke', '#e5e7eb');
    gridGroup.setAttribute('stroke-width', '0.5');

    // 1) 縦軸グリッド (25分割)
    for (let i = 0; i <= 25; i++) {
        const y = padding.top + (chartH / 25) * i;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', padding.left);
        line.setAttribute('y1', y);
        line.setAttribute('x2', padding.left + chartW);
        line.setAttribute('y2', y);
        
        // 太線調整
        if (i === 0 || i === 25) {
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.5');
        } else if (i % 5 === 0) {
            line.setAttribute('stroke', '#888888');
            line.setAttribute('stroke-width', '1');
        }
        gridGroup.appendChild(line);
    }

    // 2) 横軸グリッド (48分割) - 1時間ごと
    for (let i = 0; i <= 48; i++) {
        const x = padding.left + (chartW / 48) * i;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', x);
        line.setAttribute('y1', padding.top);
        line.setAttribute('x2', x);
        line.setAttribute('y2', padding.top + chartH);

        // 中央の境界線（24時間目）は太い実線
        if (i === 24) {
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.5');
        } else if (i === 0 || i === 48) {
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.5');
        } else if (i % 3 === 0) {
            // 3時間ごとの線
            line.setAttribute('stroke', '#aaaaaa');
            line.setAttribute('stroke-width', '0.8');
        } else {
            // 1時間ごとの細線
            line.setAttribute('stroke-dasharray', '1, 2');
        }
        gridGroup.appendChild(line);
    }
    svg.appendChild(gridGroup);

    // グローバル設定の取得 (スコープを関数全体にするため、ここで定義します)
    const tMin = state.graphSettings.tempMin;
    const tMax = state.graphSettings.tempMax;
    const hMin = state.graphSettings.humMin;
    const hMax = state.graphSettings.humMax;
    const pMin = state.graphSettings.pressMin;
    const pMax = state.graphSettings.pressMax;

    // 3) 左軸ラベル (気温: tempMin 〜 tempMax)
    const axisGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    axisGroup.setAttribute('font-family', 'sans-serif');
    axisGroup.setAttribute('font-size', '9px');
    axisGroup.setAttribute('fill', '#333');

    let tempStep = 5;
    if (tMax - tMin > 20) tempStep = 10;

    for (let t = Math.ceil(tMin / tempStep) * tempStep; t <= tMax; t += tempStep) {
        const y = padding.top + chartH - (chartH / (tMax - tMin)) * (t - tMin);
        if (y < padding.top - 1 || y > padding.top + chartH + 1) continue;

        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', padding.left - 6);
        text.setAttribute('y', y + 3);
        text.setAttribute('text-anchor', 'end');
        text.setAttribute('fill', '#dc2626');
        text.setAttribute('font-weight', 'bold');
        text.textContent = t.toString();
        axisGroup.appendChild(text);
    }

    // 左軸の単位タイトル
    const tempTitle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    tempTitle.setAttribute('x', padding.left - 5);
    tempTitle.setAttribute('y', padding.top - 12);
    tempTitle.setAttribute('font-size', '9px');
    tempTitle.setAttribute('font-weight', 'bold');
    tempTitle.setAttribute('fill', '#dc2626');
    tempTitle.setAttribute('text-anchor', 'middle');
    tempTitle.textContent = "気温(℃)";
    axisGroup.appendChild(tempTitle);

    // 4) 右軸ラベル (湿度: humMin 〜 humMax)
    let humStep = 20;
    if (hMax - hMin <= 30) humStep = 10;

    for (let h = Math.ceil(hMin / humStep) * humStep; h <= hMax; h += humStep) {
        const y = padding.top + chartH - (chartH / (hMax - hMin)) * (h - hMin);
        if (y < padding.top - 1 || y > padding.top + chartH + 1) continue;

        const textH = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        textH.setAttribute('x', padding.left + chartW + 5);
        textH.setAttribute('y', y + 3);
        textH.setAttribute('text-anchor', 'start');
        textH.setAttribute('fill', '#2563eb');
        textH.setAttribute('font-weight', 'bold');
        textH.textContent = h.toString();
        axisGroup.appendChild(textH);
    }

    // 気圧ラベル (pressMin 〜 pressMax)
    let pressStep = 10;
    if (pMax - pMin > 40) pressStep = 20;

    for (let p = Math.ceil(pMin / pressStep) * pressStep; p <= pMax; p += pressStep) {
        const y = padding.top + chartH - (chartH / (pMax - pMin)) * (p - pMin);
        if (y < padding.top - 1 || y > padding.top + chartH + 1) continue;

        const textP = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        textP.setAttribute('x', padding.left + chartW + 68);
        textP.setAttribute('y', y + 3);
        textP.setAttribute('text-anchor', 'end');
        textP.setAttribute('fill', '#16a34a');
        textP.setAttribute('font-weight', 'bold');
        textP.textContent = p.toString();
        axisGroup.appendChild(textP);
    }

    // 右軸の単位タイトル
    const humTitle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    humTitle.setAttribute('x', padding.left + chartW + 10);
    humTitle.setAttribute('y', padding.top - 12);
    humTitle.setAttribute('font-size', '9px');
    humTitle.setAttribute('font-weight', 'bold');
    humTitle.setAttribute('fill', '#2563eb');
    humTitle.setAttribute('text-anchor', 'middle');
    humTitle.textContent = "湿度(%)";
    axisGroup.appendChild(humTitle);

    const pressTitle = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    pressTitle.setAttribute('x', padding.left + chartW + 53);
    pressTitle.setAttribute('y', padding.top - 12);
    pressTitle.setAttribute('font-size', '9px');
    pressTitle.setAttribute('font-weight', 'bold');
    pressTitle.setAttribute('fill', '#16a34a');
    pressTitle.setAttribute('text-anchor', 'middle');
    pressTitle.textContent = "気圧(hPa)";
    axisGroup.appendChild(pressTitle);

    // 5) 横軸時間ラベル (3, 6, 9, 12, 15, 18, 21, 24時)
    for (let i = 3; i <= 48; i += 3) {
        const x = padding.left + (chartW / 48) * i;
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', x);
        text.setAttribute('y', padding.top + chartH + 13);
        text.setAttribute('text-anchor', 'middle');
        text.setAttribute('font-size', '9px');
        
        let hr = i;
        if (i > 24) hr -= 24;
        text.textContent = hr.toString();
        axisGroup.appendChild(text);
    }

    // 横軸の（時）表記
    const hrUnit = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    hrUnit.setAttribute('x', padding.left + chartW + 14);
    hrUnit.setAttribute('y', padding.top + chartH + 13);
    hrUnit.setAttribute('font-size', '9px');
    hrUnit.textContent = "(時)";
    axisGroup.appendChild(hrUnit);

    // 6) 日付ラベル（グリッド最上部）
    const dayLabelY = padding.top - 12;
    
    // グラフの左側の日付
    const leftDayText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    leftDayText.setAttribute('x', padding.left + chartW * 0.25);
    leftDayText.setAttribute('y', dayLabelY);
    leftDayText.setAttribute('text-anchor', 'middle');
    leftDayText.setAttribute('font-size', '10px');
    leftDayText.setAttribute('font-weight', 'bold');
    
    const dLeft = state.dates[graphIdx * 2];
    leftDayText.textContent = dLeft ? `${dLeft.month}月${dLeft.day}日` : "月  日";
    axisGroup.appendChild(leftDayText);

    // グラフの右側の日付
    const rightDayText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    rightDayText.setAttribute('x', padding.left + chartW * 0.75);
    rightDayText.setAttribute('y', dayLabelY);
    rightDayText.setAttribute('text-anchor', 'middle');
    rightDayText.setAttribute('font-size', '10px');
    rightDayText.setAttribute('font-weight', 'bold');

    const dRight = state.dates[graphIdx * 2 + 1];
    // 下グラフの右半分はデータが空なので、空であることを示すか、または日付を表示
    if (graphIdx === 1) {
        rightDayText.textContent = ""; // 下グラフ右側は余白
    } else {
        rightDayText.textContent = dRight ? `${dRight.month}月${dRight.day}日` : "月  日";
    }
    axisGroup.appendChild(rightDayText);

    // グリッド下の見出し「風向 風力 天気」
    const legendText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    legendText.setAttribute('x', padding.left - 8);
    legendText.setAttribute('y', padding.top + chartH + 27);
    legendText.setAttribute('font-size', '8px');
    legendText.setAttribute('text-anchor', 'end');
    legendText.setAttribute('font-weight', 'bold');
    
    // 3行に分けて表示
    const tspan1 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    tspan1.setAttribute('x', padding.left - 8);
    tspan1.setAttribute('dy', '0');
    tspan1.textContent = "風向";
    
    const tspan2 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    tspan2.setAttribute('x', padding.left - 8);
    tspan2.setAttribute('dy', '11');
    tspan2.textContent = "風力";

    const tspan3 = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
    tspan3.setAttribute('x', padding.left - 8);
    tspan3.setAttribute('dy', '11');
    tspan3.textContent = "天気";
    
    legendText.appendChild(tspan1);
    legendText.appendChild(tspan2);
    legendText.appendChild(tspan3);
    axisGroup.appendChild(legendText);

    svg.appendChild(axisGroup);

    // ==========================================================================
    // データのプロット (気温・湿度・気圧の折れ線)
    // ==========================================================================
    const dataPointsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    
    const tempCoords = [];
    const humCoords = [];
    const pressCoords = [];

    // データ座標のマッピング
    data.forEach((r, idx) => {
        // x座標 (0〜48時間分に線形配置)
        const x = padding.left + (chartW / 48) * idx;

        // 気温のマッピング
        if (!isNaN(r.temp)) {
            const tempClamped = Math.max(tMin, Math.min(tMax, r.temp));
            const yTemp = padding.top + chartH - (chartH / (tMax - tMin)) * (tempClamped - tMin);
            tempCoords.push(`${x},${yTemp}`);
        }

        // 湿度のマッピング
        if (!isNaN(r.humidity)) {
            const humClamped = Math.max(hMin, Math.min(hMax, r.humidity));
            const yHum = padding.top + chartH - (chartH / (hMax - hMin)) * (humClamped - hMin);
            humCoords.push(`${x},${yHum}`);
        }

        // 気圧のマッピング (pMin〜pMax を 0〜chartH)
        if (!isNaN(r.pressure)) {
            const pressClamped = Math.max(pMin, Math.min(pMax, r.pressure));
            const yPress = padding.top + chartH - (chartH / (pMax - pMin)) * (pressClamped - pMin);
            pressCoords.push(`${x},${yPress}`);
        }
    });

    // 折れ線を描画
    // 1. 湿度（青、実線）
    if (humCoords.length > 0) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${humCoords.join(' L ')}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#2563eb'); // ロイヤルブルー
        path.setAttribute('stroke-width', '1.2');
        dataPointsGroup.appendChild(path);
    }

    // 2. 気圧（緑、1点鎖線または点線）
    if (pressCoords.length > 0) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${pressCoords.join(' L ')}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#16a34a'); // フォレストグリーン
        path.setAttribute('stroke-width', '1.2');
        path.setAttribute('stroke-dasharray', '4, 2, 1, 2'); // 1点鎖線
        dataPointsGroup.appendChild(path);
    }

    // 3. 気温（赤、太めの実線）
    if (tempCoords.length > 0) {
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', `M ${tempCoords.join(' L ')}`);
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', '#dc2626'); // 真紅
        path.setAttribute('stroke-width', '1.6');
        dataPointsGroup.appendChild(path);
    }

    svg.appendChild(dataPointsGroup);

    // ==========================================================================
    // 気象記号の描画 (3時間おき)
    // ==========================================================================
    const symbolsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');

    // 3時間おきのデータポイントインデックス（3, 6, 9, 12, 15, 18, 21, 24, 27, 30...）
    // 1から始まる3時間ごとの値
    for (let i = 3; i <= 48; i += 3) {
        const dataIdx = i - 1; // 0-indexed配列のインデックス
        if (dataIdx >= data.length) continue;

        const record = data[dataIdx];
        const x = padding.left + (chartW / 48) * i;
        const ySymbol = padding.top + chartH + 38; // 記号の丸印の中心座標 (凡例「天気」の位置に揃える)

        // 1) 土台の円を描画
        // この円は日本式天気記号のベース（快晴や晴れなど）になります
        const weatherGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        weatherGroup.setAttribute('transform', `translate(${x}, ${ySymbol})`);

        drawWeatherSymbol(weatherGroup, record.weatherCode);
        symbolsGroup.appendChild(weatherGroup);

        // 2) 風向棒 & 風力羽の描画
        if (record.windDir && record.windDir !== "静穏" && !isNaN(record.windSpeed)) {
            const angle = getWindAngle(record.windDir);
            const force = getWindForce(record.windSpeed);

            if (angle >= 0 && force > 0) {
                const windGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                // 風が吹いてくる方向へ回転（0度が北、時計回り。風向棒は吹いてくる方向へ伸ばすため、180度回転させずにそのままの向きへ伸ばす）
                // ただし、風向の定義：北風は北（上）から吹くため、上向きに棒を伸ばす。
                // よって、回転角は angle度。
                windGroup.setAttribute('transform', `translate(${x}, ${ySymbol}) rotate(${angle})`);

                const windBar = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                windBar.setAttribute('x1', 0);
                windBar.setAttribute('y1', -7); // 円の縁から伸ばす (半径は5.5)
                windBar.setAttribute('x2', 0);
                windBar.setAttribute('y2', -24); // 長さ17px
                windBar.setAttribute('stroke', '#333333');
                windBar.setAttribute('stroke-width', '1.2');
                windGroup.appendChild(windBar);

                // 風力羽を描画 (棒の先端から下に向けて60度の角度で生やす)
                drawWindFeathers(windGroup, force);
                symbolsGroup.appendChild(windGroup);
            }
        }
    }

    svg.appendChild(symbolsGroup);
    container.appendChild(svg);
}

// --------------------------------------------------------------------------
// 風向・風力の計算ヘルパー
// --------------------------------------------------------------------------
const windDirs = {
    "北": 0, "北北東": 22.5, "北東": 45, "東北東": 67.5,
    "東": 90, "東南東": 112.5, "南東": 135, "南南東": 157.5,
    "南": 180, "南南西": 202.5, "南西": 225, "西南西": 247.5,
    "西": 270, "西北西": 292.5, "北西": 315, "北北西": 337.5,
    "静穏": -1
};

function getWindAngle(dirStr) {
    if (windDirs[dirStr] !== undefined) return windDirs[dirStr];
    return -1;
}

function getWindForce(speed) {
    if (speed <= 0.2) return 0;
    if (speed <= 1.5) return 1;
    if (speed <= 3.3) return 2;
    if (speed <= 5.4) return 3;
    if (speed <= 7.9) return 4;
    if (speed <= 10.7) return 5;
    if (speed <= 13.8) return 6;
    if (speed <= 17.1) return 7;
    if (speed <= 20.7) return 8;
    if (speed <= 24.4) return 9;
    if (speed <= 28.4) return 10;
    if (speed <= 32.6) return 11;
    return 12;
}

// 風力羽を描画 (日本式)
// 日本式天気図記号のルール：
// - 風力 = 羽の総数
// - 長さのルール：
//   - 風力 1 の場合：短い羽を右側に1本描く。
//   - 風力 2〜6 の場合：一番先端（1本目）を長い羽、残りの (風力 - 1) 本を短い羽として右側に描く。
//   - 風力 7〜12 の場合：右側に長い羽1本と短い羽5本（合計6本）を描き、反対側（左側）に (風力 - 6) 本の短い羽を描く。
function drawWindFeathers(group, force) {
    const featherAngle = 60; // 棒に対する角度 (右に傾ける)
    const rad = (featherAngle * Math.PI) / 180;
    
    // 羽を描画するY座標のリスト (先端側から下へ並べる)
    const yStarts = [-24, -21.5, -19, -16.5, -14, -11.5];
    
    if (force <= 0) return;

    if (force === 1) {
        // 風力1: 右側に短い羽1本
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', 0);
        line.setAttribute('y1', yStarts[0]);
        line.setAttribute('x2', 3.5 * Math.sin(rad));
        line.setAttribute('y2', yStarts[0] - 3.5 * Math.cos(rad));
        line.setAttribute('stroke', '#333333');
        line.setAttribute('stroke-width', '1.2');
        group.appendChild(line);
    } else if (force <= 6) {
        // 風力2〜6: 右側に長い羽1本、短い羽 (force - 1) 本
        for (let i = 0; i < force; i++) {
            const yStart = yStarts[i];
            if (yStart === undefined) break;

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0);
            line.setAttribute('y1', yStart);

            const length = (i === 0) ? 6.5 : 3.5; // 先端（1本目）のみ長い羽、それ以外は短い羽
            line.setAttribute('x2', length * Math.sin(rad));
            line.setAttribute('y2', yStart - length * Math.cos(rad));
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.2');
            group.appendChild(line);
        }
    } else {
        // 風力7〜12: 右側に長い羽1本＋短い羽5本。左側に短い羽 (force - 6) 本
        // 1. 右側 (6本)
        for (let i = 0; i < 6; i++) {
            const yStart = yStarts[i];
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0);
            line.setAttribute('y1', yStart);

            const length = (i === 0) ? 6.5 : 3.5;
            line.setAttribute('x2', length * Math.sin(rad));
            line.setAttribute('y2', yStart - length * Math.cos(rad));
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.2');
            group.appendChild(line);
        }
        // 2. 左側 (force - 6 本の羽)
        // 左側も右側と同様に、1本目（先端）のみ長い羽、それ以降は短い羽を描く
        const leftCount = force - 6;
        for (let i = 0; i < leftCount; i++) {
            const yStart = yStarts[i];
            if (yStart === undefined) break;

            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0);
            line.setAttribute('y1', yStart);

            const length = (i === 0) ? 6.5 : 3.5; // 先端（1本目）のみ長い羽、それ以外は短い羽
            line.setAttribute('x2', -length * Math.sin(rad)); // X座標をマイナスにして左へ伸ばす
            line.setAttribute('y2', yStart - length * Math.cos(rad));
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.2');
            group.appendChild(line);
        }
    }
}

// --------------------------------------------------------------------------
// 日本式天気記号の描画
// --------------------------------------------------------------------------
function drawWeatherSymbol(group, code) {
    const r = 5.5; // 外円の半径
    
    // 外円は基本すべての天気に共通 (快晴、晴、曇、雨、雪などのベース)
    const baseCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    baseCircle.setAttribute('cx', 0);
    baseCircle.setAttribute('cy', 0);
    baseCircle.setAttribute('r', r);
    baseCircle.setAttribute('stroke', '#333333');
    baseCircle.setAttribute('stroke-width', '1.0');
    
    // デフォルトは白塗り
    baseCircle.setAttribute('fill', '#ffffff');

    // 天気コードに基づくマッピング (日本式天気記号)
    // 1:快晴, 2:晴, 3:薄曇, 4:曇, 8:霧, 9:霧雨, 10:雨, 12:雪
    switch (code) {
        case 1: // 快晴: ◯ (白丸)
            baseCircle.setAttribute('fill', '#ffffff');
            group.appendChild(baseCircle);
            break;
            
        case 2: // 晴: ⦶ (白丸に縦線1本)
            baseCircle.setAttribute('fill', '#ffffff');
            group.appendChild(baseCircle);
            
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', 0);
            line.setAttribute('y1', -r);
            line.setAttribute('x2', 0);
            line.setAttribute('y2', r);
            line.setAttribute('stroke', '#333333');
            line.setAttribute('stroke-width', '1.0');
            group.appendChild(line);
            break;

        case 3: // 薄曇: ◎
        case 4: // 曇: ◎ (二重丸)
            baseCircle.setAttribute('fill', '#ffffff');
            group.appendChild(baseCircle);
            
            const innerCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            innerCircle.setAttribute('cx', 0);
            innerCircle.setAttribute('cy', 0);
            innerCircle.setAttribute('r', r - 2);
            innerCircle.setAttribute('stroke', '#333333');
            innerCircle.setAttribute('stroke-width', '1.0');
            innerCircle.setAttribute('fill', 'none');
            group.appendChild(innerCircle);
            break;

        case 8: // 霧: ＝ (丸の中に＝)
            baseCircle.setAttribute('fill', '#ffffff');
            group.appendChild(baseCircle);
            
            const lineFog1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            lineFog1.setAttribute('x1', -3);
            lineFog1.setAttribute('y1', -1.5);
            lineFog1.setAttribute('x2', 3);
            lineFog1.setAttribute('y2', -1.5);
            lineFog1.setAttribute('stroke', '#333333');
            lineFog1.setAttribute('stroke-width', '1.0');
            group.appendChild(lineFog1);

            const lineFog2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            lineFog2.setAttribute('x1', -3);
            lineFog2.setAttribute('y1', 1.5);
            lineFog2.setAttribute('x2', 3);
            lineFog2.setAttribute('y2', 1.5);
            lineFog2.setAttribute('stroke', '#333333');
            lineFog2.setAttribute('stroke-width', '1.0');
            group.appendChild(lineFog2);
            break;

        case 9:  // 霧雨
        case 10: // 雨: ● (黒塗り潰し)
        case 11: // みぞれ (本当は左雨右雪ですが、簡易的に雨として黒塗りか、または専用描画)
            baseCircle.setAttribute('fill', '#333333');
            group.appendChild(baseCircle);
            break;

        case 12: // 雪: (◯の中に雪の結晶のようなアスタリスクまたはトの組み合わせ)
            baseCircle.setAttribute('fill', '#ffffff');
            group.appendChild(baseCircle);
            
            // 簡易アスタリスクを描画
            for (let angle = 0; angle < 180; angle += 60) {
                const rad = (angle * Math.PI) / 180;
                const x1 = (r - 0.5) * Math.sin(rad);
                const y1 = -(r - 0.5) * Math.cos(rad);
                const x2 = -x1;
                const y2 = -y1;

                const sLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                sLine.setAttribute('x1', x1);
                sLine.setAttribute('y1', y1);
                sLine.setAttribute('x2', x2);
                sLine.setAttribute('y2', y2);
                sLine.setAttribute('stroke', '#333333');
                sLine.setAttribute('stroke-width', '0.8');
                group.appendChild(sLine);
            }
            break;

        default: // 未定義時は通常の白丸
            baseCircle.setAttribute('fill', '#ffffff');
            group.appendChild(baseCircle);
            break;
    }
}

// ==========================================================================
// 6. 天気図一括切り出し・保存・ダウンロード用追加ロジック
// ==========================================================================


// ==========================================================================
// 7. PDFのアップロード提出機能 (GAS連携)
// ==========================================================================

const GAS_WEBAPP_URL = "https://script.google.com/macros/s/AKfycbzGK7T9YRaClwjsrAYpwsQrVrpErw5Kg-1LvBd04-hlwtuEt01DSkb4zT5qAfM_dFpkQA/exec";

function uploadPdfToDrive() {
    const fileInput = document.getElementById('submit-pdf-file');
    const group = document.getElementById('student-group').value.trim();
    const name = document.getElementById('student-name').value.trim();
    const btn = document.getElementById('submit-btn');
    
    if (!name) {
        alert("上の「3. 提出情報」で名前を入力してください。");
        return;
    }
    if (!fileInput.files || fileInput.files.length === 0) {
        alert("保存したPDFファイルを選択してください。");
        return;
    }
    
    const file = fileInput.files[0];
    const fileName = (group ? group + "_" : "") + name + ".pdf";
    
    const originalText = btn.innerHTML;
    btn.innerHTML = "アップロード中...";
    btn.disabled = true;

    const reader = new FileReader();
    reader.onload = function(e) {
        // Base64データを取り出す (data:application/pdf;base64, の後)
        const base64Data = e.target.result.split(',')[1];
        
        const payload = JSON.stringify({
            fileName: fileName,
            fileData: base64Data,
            contentType: file.type
        });

        // 匿名としてGASへ送信（ブラウザのブロックを回避）
        fetch(GAS_WEBAPP_URL, {
            method: 'POST',
            mode: 'no-cors',
            credentials: 'omit',
            headers: {
                'Content-Type': 'text/plain',
            },
            body: payload
        })
        .then(() => {
            alert("「" + fileName + "」として先生のフォルダに提出しました！");
            fileInput.value = ""; // リセット
        })
        .catch(error => {
            console.error(error);
            alert("エラーが発生しました。時間をおいて再度お試しください。");
        })
        .finally(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
        });
    };
    
    reader.onerror = function(error) {
        alert("ファイルの読み込みに失敗しました。");
        btn.innerHTML = originalText;
        btn.disabled = false;
    };
    
    reader.readAsDataURL(file);
}

// ユーザーが手動で天気図のズレを微調整する関数
window.updateCropSettings = function() {
    const x = parseFloat(document.getElementById('adj-x').value);
    const y = parseFloat(document.getElementById('adj-y').value);
    const w = parseFloat(document.getElementById('adj-w').value);
    const h = parseFloat(document.getElementById('adj-h').value);
    
    // 現在の数値を画面に表示する
    document.getElementById('val-x').innerText = x.toFixed(1);
    document.getElementById('val-y').innerText = y.toFixed(1);
    document.getElementById('val-w').innerText = w.toFixed(1);
    document.getElementById('val-h').innerText = h.toFixed(1);
    
    // 全ての日付に適用
    for (let i = 0; i < 3; i++) {
        state.cropSettings[i].x = x;
        state.cropSettings[i].y = y;
        state.cropSettings[i].w = w;
        state.cropSettings[i].h = h;
    }
    
    if (state.pdfFiles && state.pdfFiles.length > 0) {
        for (let i = 0; i < 3; i++) drawCrop(i);
    }
};


// 描画専用の関数（ドラッグ等で高速に再描画するため）
function drawCrop(dayIdx) {
    const info = state.cropOffsets[dayIdx];
    if (!info.tempCanvas) return;
    
    const tempCanvas = info.tempCanvas;
    const cellIdx = info.cellIdx;
    
    const canvas = document.getElementById(`crop-canvas-${dayIdx + 1}`);
    const ctx = canvas.getContext('2d');
    
    const W = tempCanvas.width;
    const H = tempCanvas.height;
    const settings = state.cropSettings[dayIdx];
    
    const gridX = W * (settings.x / 100);
    const gridY = H * (settings.y / 100);
    const gridW = W * (settings.w / 100);
    const gridH = H * (settings.h / 100);

    const cellW = gridW / 4;
    const cellH = gridH / 4;

    const col = cellIdx % 4;
    const row = Math.floor(cellIdx / 4);

    const sx = gridX + col * cellW - info.dx;
    const sy = gridY + row * cellH - info.dy;

    const sw = cellW;
    const sh = state.displayMode === "image" ? cellH : cellH * 0.73; 
    const pad = settings.pad;

    canvas.width = sw - pad * 2;
    canvas.height = sh - pad * 2;

    ctx.drawImage(tempCanvas, sx + pad, sy + pad, sw - pad * 2, sh - pad * 2, 0, 0, canvas.width, canvas.height);

    const dataUrl = canvas.toDataURL('image/png');
    state.dayNotes[dayIdx].mapSrc = dataUrl;
    
    const imgEl = document.getElementById(`weather-map-${dayIdx + 1}`);
    if (imgEl) imgEl.src = dataUrl;
}

// img要素へのドラッグ（パン）操作をセットアップ
function setupCanvasDrag() {
    for (let i = 0; i < 3; i++) {
        const imgEl = document.getElementById(`weather-map-${i + 1}`);
        if (!imgEl) continue;
        
        imgEl.style.cursor = 'grab'; imgEl.draggable = false;
        
        let isDragging = false;
        let lastX = 0;
        let lastY = 0;
        
        const startDrag = (x, y) => {
            isDragging = true;
            lastX = x;
            lastY = y;
            imgEl.style.cursor = 'grabbing';
        };
        
        const doDrag = (x, y) => {
            if (!isDragging) return;
            const dx = x - lastX;
            const dy = y - lastY;
            lastX = x;
            lastY = y;
            
            // 画面上のピクセル移動量を、Canvas上のピクセルに変換
            // imgEl.clientWidth が画面上の表示幅。
            const canvas = document.getElementById(`crop-canvas-${i + 1}`);
            if(!canvas || !canvas.width) return;
            
            const scaleX = canvas.width / imgEl.clientWidth;
            const scaleY = canvas.height / imgEl.clientHeight;
            
            state.cropOffsets[i].dx += dx * scaleX;
            state.cropOffsets[i].dy += dy * scaleY;
            
            drawCrop(i);
        };
        
        const endDrag = () => {
            isDragging = false;
            imgEl.style.cursor = 'grab'; imgEl.draggable = false;
        };
        
        imgEl.addEventListener('mousedown', (e) => { e.preventDefault(); startDrag(e.clientX, e.clientY); });
        window.addEventListener('mousemove', (e) => doDrag(e.clientX, e.clientY));
        window.addEventListener('mouseup', endDrag);
        
        imgEl.addEventListener('touchstart', (e) => {
            if (e.touches.length > 0) {
                e.preventDefault();
                startDrag(e.touches[0].clientX, e.touches[0].clientY);
            }
        });
        window.addEventListener('touchmove', (e) => {
            if (e.touches.length > 0) {
                e.preventDefault();
                doDrag(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, {passive: false});
        window.addEventListener('touchend', endDrag);
    }
}

// ==========================================================================
// 10. 授業予定マネージャー (Web編集・パスワード保護・動的レンダリング)
// ==========================================================================

const STORAGE_KEY_SCHEDULE = 'weather_portal_schedule';
const ADMIN_PASSWORD = 'weather2026';
let isScheduleAdmin = false;

// デフォルト予定データ（14回分）
const defaultScheduleData = [
    { date: "2026/09/14", phase: "導入", phaseClass: "phase-intro", title: "ルーブリック提示・ガイダンス / 特別な日を決める", lessonTag: "ミニレッスン", lessonDesc: "気象要素について", isBh: false, isGoal: false },
    { date: "2026/09/16", phase: "特別講義", phaseClass: "phase-lecture", title: "気象予報士からの特別講義", lessonTag: "講義", lessonDesc: "プロの気象予報士から気象の見方・番組づくりのコツを学ぶ", isBh: false, isGoal: false },
    { date: "2026/09/17", phase: "データ収集", phaseClass: "phase-work", title: "特別な日を決めてHPでグラフと天気図のプリントをつくる / 「時間と空間」のつながりを考察する", lessonTag: "ミニレッスン", lessonDesc: "グラフの見方（気温・湿度・気圧の関係）", isBh: false, isGoal: false },
    { date: "2026/09/25", phase: "探究", phaseClass: "phase-explore", title: "観天望気を事象のつながりを整理して科学的に考察", lessonTag: "ミニレッスン", lessonDesc: "観天望気とは（先人の知恵と科学の架け橋）", isBh: false, isGoal: false },
    { date: "2026/09/28", phase: "探究", phaseClass: "phase-explore", title: "特別な日の気温・湿度・気圧のグラフと天気図から「時間と空間」のつながりを考察", lessonTag: "ミニレッスン", lessonDesc: "天気図の見方・活用サイトの紹介", isBh: false, isGoal: false },
    { date: "2026/09/30", phase: "探究", phaseClass: "phase-explore", title: "観天望気を事象のつながりを整理して科学的に考察（思考ツール活用）", lessonTag: "探究作業", lessonDesc: "ステップチャート・クラゲチャートで深める", isBh: false, isGoal: false },
    { date: "2026/10/02", phase: "探究", phaseClass: "phase-explore", title: "観天望気を事象のつながりを整理して科学的に考察（まとめと共有）", lessonTag: "探究作業", lessonDesc: "科学的根拠の整理と参考文献の記録", isBh: false, isGoal: false },
    { date: "BH（9/28の週）", phase: "ブロックアワー", phaseClass: "phase-bh", title: "スライドづくり（構成案・原稿の下書き）", lessonTag: "個別探究", lessonDesc: "構成シートと台本の作成", isBh: true, isGoal: false },
    { date: "2026/10/13", phase: "制作", phaseClass: "phase-creation", title: "スライドづくり（天気の空間的・時間的解説の作成）", lessonTag: "ミニレッスン", lessonDesc: "四季による天気図の特徴", isBh: false, isGoal: false },
    { date: "BH（10/12の週）", phase: "ブロックアワー", phaseClass: "phase-bh", title: "スライドづくり（スライド完成・発表リハーサル）", lessonTag: "個別探究", lessonDesc: "スライド完成と発表練習", isBh: true, isGoal: false },
    { date: "2026/10/19", phase: "動画制作", phaseClass: "phase-creation", title: "天気予報動画の作成（撮影開始）", lessonTag: "ミニレッスン", lessonDesc: "動画の撮り方（見やすい画面・聞き取りやすい話し方）", isBh: false, isGoal: false },
    { date: "2026/10/21", phase: "動画制作", phaseClass: "phase-creation", title: "天気予報動画の作成（撮影・編集）", lessonTag: "制作作業", lessonDesc: "動画のブラッシュアップ", isBh: false, isGoal: false },
    { date: "2026/10/23", phase: "動画制作", phaseClass: "phase-creation", title: "天気予報動画の作成（動画完成・最終提出）", lessonTag: "制作作業", lessonDesc: "提出用フォルダへアップロード", isBh: false, isGoal: false },
    { date: "2026/10/27", phase: "最終発表", phaseClass: "phase-showcase", title: "鑑賞会（お互いの番組を見合って相互評価・振り返り）", lessonTag: "発表・省察", lessonDesc: "ルーブリックを用いた振り返り", isBh: false, isGoal: true }
];

function getScheduleData() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_SCHEDULE);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.warn('LocalStorage error:', e);
    }
    return defaultScheduleData;
}

function saveScheduleData(data) {
    try {
        localStorage.setItem(STORAGE_KEY_SCHEDULE, JSON.stringify(data));
    } catch (e) {
        console.warn('LocalStorage save error:', e);
    }
}

function initScheduleManager() {
    renderScheduleTimeline();
}

function getPhaseClassFromPhase(phase) {
    switch (phase) {
        case '導入': return 'phase-intro';
        case '特別講義': return 'phase-lecture';
        case 'データ収集': return 'phase-work';
        case '探究': return 'phase-explore';
        case 'ブロックアワー': return 'phase-bh';
        case '制作':
        case '動画制作': return 'phase-creation';
        case '最終発表': return 'phase-showcase';
        default: return 'phase-explore';
    }
}

function renderScheduleTimeline() {
    const container = document.getElementById('scheduleTimeline');
    if (!container) return;

    const data = getScheduleData();
    container.innerHTML = '';

    data.forEach((item, index) => {
        const row = document.createElement('div');
        let classes = ['schedule-row'];
        if (item.isBh) classes.push('schedule-bh');
        if (item.isGoal) classes.push('schedule-goal');
        row.className = classes.join(' ');

        const pClass = item.phaseClass || getPhaseClassFromPhase(item.phase);

        let adminActionsHtml = '';
        if (isScheduleAdmin) {
            adminActionsHtml = `
                <div class="schedule-admin-actions">
                    <button class="btn-icon-action btn-move-up" onclick="moveScheduleItem(${index}, -1)" title="上へ移動" ${index === 0 ? 'disabled' : ''}>⬆️</button>
                    <button class="btn-icon-action btn-move-down" onclick="moveScheduleItem(${index}, 1)" title="下へ移動" ${index === data.length - 1 ? 'disabled' : ''}>⬇️</button>
                    <button class="btn-icon-action btn-edit" onclick="openScheduleModal(${index})" title="編集">✏️ 編集</button>
                    <button class="btn-icon-action btn-delete" onclick="deleteScheduleItem(${index})" title="削除">🗑️</button>
                </div>
            `;
        }

        row.innerHTML = `
            <div class="schedule-date-badge">${escapeHtml(item.date)}</div>
            <div class="schedule-content">
                <div class="schedule-main">
                    <span class="schedule-phase ${pClass}">${escapeHtml(item.phase)}</span>
                    <h4>${escapeHtml(item.title)}</h4>
                </div>
                ${item.lessonTag || item.lessonDesc ? `
                    <div class="schedule-lesson">
                        ${item.lessonTag ? `<span class="lesson-tag">${escapeHtml(item.lessonTag)}</span>` : ''}
                        ${item.lessonDesc ? `<span>${escapeHtml(item.lessonDesc)}</span>` : ''}
                    </div>
                ` : ''}
                ${adminActionsHtml}
            </div>
        `;

        container.appendChild(row);
    });

    // 先生用ツールバーとロックボタンの状態を更新
    const toolbar = document.getElementById('scheduleAdminToolbar');
    const lockIcon = document.getElementById('lockIcon');
    const lockText = document.getElementById('lockText');
    const btnLock = document.getElementById('btnScheduleLock');
    const mogiAdminActions = document.getElementById('mogiAdminActions');

    if (toolbar) toolbar.style.display = isScheduleAdmin ? 'flex' : 'none';
    if (lockIcon) lockIcon.textContent = isScheduleAdmin ? '🔓' : '🔒';
    if (lockText) lockText.textContent = isScheduleAdmin ? '編集中（クリックで終了）' : '先生用編集';
    if (btnLock) {
        if (isScheduleAdmin) {
            btnLock.classList.add('active');
        } else {
            btnLock.classList.remove('active');
        }
    }
    if (mogiAdminActions) {
        mogiAdminActions.style.display = isScheduleAdmin ? 'flex' : 'none';
    }
}

function toggleScheduleEditMode() {
    if (isScheduleAdmin) {
        exitScheduleEditMode();
    } else {
        openPasswordModal();
    }
}
window.toggleScheduleEditMode = toggleScheduleEditMode;

function openPasswordModal() {
    const backdrop = document.getElementById('modalPasswordBackdrop');
    const input = document.getElementById('passwordInput');
    const err = document.getElementById('passwordError');
    if (backdrop) backdrop.style.display = 'flex';
    if (err) err.style.display = 'none';
    if (input) {
        input.value = '';
        setTimeout(() => input.focus(), 100);
    }
}
window.openPasswordModal = openPasswordModal;

function closePasswordModal() {
    const backdrop = document.getElementById('modalPasswordBackdrop');
    if (backdrop) backdrop.style.display = 'none';
}
window.closePasswordModal = closePasswordModal;

function verifySchedulePassword() {
    const input = document.getElementById('passwordInput');
    const err = document.getElementById('passwordError');
    if (!input) return;

    if (input.value === ADMIN_PASSWORD) {
        isScheduleAdmin = true;
        closePasswordModal();
        renderScheduleTimeline();
        renderMogiQASection();
        showToast('先生用編集モードを有効にしました');
    } else {
        if (err) {
            err.style.display = 'block';
            err.textContent = 'パスワードが違います（初期値: weather2026）';
        }
    }
}
window.verifySchedulePassword = verifySchedulePassword;

function exitScheduleEditMode() {
    isScheduleAdmin = false;
    renderScheduleTimeline();
    renderMogiQASection();
    showToast('編集モードを終了しました');
}
window.exitScheduleEditMode = exitScheduleEditMode;

function openScheduleModal(index = -1) {
    const backdrop = document.getElementById('modalScheduleBackdrop');
    const titleEl = document.getElementById('scheduleModalTitle');
    const idxInput = document.getElementById('schedEditIndex');
    const dateInput = document.getElementById('schedDate');
    const phaseSelect = document.getElementById('schedPhase');
    const titleInput = document.getElementById('schedTitle');
    const tagInput = document.getElementById('schedLessonTag');
    const descInput = document.getElementById('schedLessonDesc');
    const isBhCheck = document.getElementById('schedIsBh');
    const isGoalCheck = document.getElementById('schedIsGoal');

    if (!backdrop) return;

    if (index >= 0) {
        const data = getScheduleData();
        const item = data[index];
        titleEl.textContent = '予定を編集';
        idxInput.value = index;
        dateInput.value = item.date || '';
        phaseSelect.value = item.phase || '探究';
        titleInput.value = item.title || '';
        tagInput.value = item.lessonTag || '';
        descInput.value = item.lessonDesc || '';
        isBhCheck.checked = !!item.isBh;
        isGoalCheck.checked = !!item.isGoal;
    } else {
        titleEl.textContent = '予定を新規追加';
        idxInput.value = -1;
        dateInput.value = '';
        phaseSelect.value = '探究';
        titleInput.value = '';
        tagInput.value = 'ミニレッスン';
        descInput.value = '';
        isBhCheck.checked = false;
        isGoalCheck.checked = false;
    }

    backdrop.style.display = 'flex';
}
window.openScheduleModal = openScheduleModal;

function closeScheduleModal() {
    const backdrop = document.getElementById('modalScheduleBackdrop');
    if (backdrop) backdrop.style.display = 'none';
}
window.closeScheduleModal = closeScheduleModal;

function saveScheduleItem() {
    const idx = parseInt(document.getElementById('schedEditIndex').value, 10);
    const date = document.getElementById('schedDate').value.trim();
    const phase = document.getElementById('schedPhase').value;
    const title = document.getElementById('schedTitle').value.trim();
    const lessonTag = document.getElementById('schedLessonTag').value.trim();
    const lessonDesc = document.getElementById('schedLessonDesc').value.trim();
    const isBh = document.getElementById('schedIsBh').checked;
    const isGoal = document.getElementById('schedIsGoal').checked;

    if (!date || !title) {
        alert('日付と授業タイトルは必須入力です。');
        return;
    }

    const item = {
        date,
        phase,
        phaseClass: getPhaseClassFromPhase(phase),
        title,
        lessonTag,
        lessonDesc,
        isBh,
        isGoal
    };

    const data = [...getScheduleData()];
    if (idx >= 0 && idx < data.length) {
        data[idx] = item;
    } else {
        data.push(item);
    }

    saveScheduleData(data);
    closeScheduleModal();
    renderScheduleTimeline();
    showToast('予定を保存しました');
}
window.saveScheduleItem = saveScheduleItem;

function deleteScheduleItem(index) {
    const data = getScheduleData();
    if (!data[index]) return;
    if (confirm(`「${data[index].date}: ${data[index].title}」を削除してもよろしいですか？`)) {
        const newData = data.filter((_, i) => i !== index);
        saveScheduleData(newData);
        renderScheduleTimeline();
        showToast('予定を削除しました');
    }
}
window.deleteScheduleItem = deleteScheduleItem;

function moveScheduleItem(index, direction) {
    const data = [...getScheduleData()];
    const targetIdx = index + direction;
    if (targetIdx < 0 || targetIdx >= data.length) return;

    const temp = data[index];
    data[index] = data[targetIdx];
    data[targetIdx] = temp;

    saveScheduleData(data);
    renderScheduleTimeline();
}
window.moveScheduleItem = moveScheduleItem;

function exportScheduleCode() {
    const data = getScheduleData();
    const jsonStr = JSON.stringify(data, null, 4);
    navigator.clipboard.writeText(jsonStr).then(() => {
        showToast('最新予定データをクリップボードにコピーしました！コードに貼り付け可能です');
    }).catch(() => {
        prompt('以下のJSONデータをコピーして保存してください:', jsonStr);
    });
}
window.exportScheduleCode = exportScheduleCode;

function resetScheduleData() {
    if (confirm('予定を初期状態に戻しますか？（現在の編集内容は上書きされます）')) {
        saveScheduleData(defaultScheduleData);
        renderScheduleTimeline();
        showToast('予定を初期データにリセットしました');
    }
}
window.resetScheduleData = resetScheduleData;

// ==========================================================================
// 11. 単元項目別・学習リソースまとめ (5項目 ✕ 4リソース)
// ==========================================================================

const learningTopicsData = [
    {
        id: 1,
        number: "1",
        title: "気象要素（気温、湿度、気圧、天気、風向・風力）の表し方",
        badge: "基礎知識・観測",
        desc: "気温・湿度・気圧の測定方法や乾湿計の使い方、天気記号・風向風力（16方位・風力階級）の正しい表し方を復習できます。",
        resources: [
            {
                type: "video",
                siteName: "授業アーカイブ",
                badge: "授業動画",
                icon: "🎥",
                desc: "気象要素の測り方と記録のポイント解説動画",
                links: [
                    {
                        title: "気象要素の表し方（授業動画）",
                        url: "https://drive.google.com/file/d/1kDWMAeGy-tlRWXKdV2BJ0-wHzUmuvi3K/view?usp=drive_link"
                    }
                ]
            },
            {
                type: "sawanii",
                siteName: "さわにいの理科サイト",
                badge: "さわにい",
                icon: "👨‍🏫",
                desc: "天気記号・等圧線・気圧の特徴をイラスト図解で学習",
                links: [
                    {
                        title: "天気記号の表し方・風向風力",
                        url: "https://sawanii.ne.jp/weather-symbol/"
                    },
                    {
                        title: "等圧線の引き方とルール",
                        url: "https://sawanii.ne.jp/isobar/"
                    },
                    {
                        title: "高気圧と低気圧の特徴",
                        url: "https://sawanii.ne.jp/high-pressure-low-pressure/"
                    }
                ]
            },
            {
                type: "furikaeru",
                siteName: "理科の授業をふりかえる",
                badge: "理科の授業をふりかえる",
                icon: "🎬",
                desc: "要点解説動画とわかりやすいスライドまとめ",
                links: [
                    {
                        title: "天気記号と風向・風力の表し方",
                        url: "https://hario-science.com/weather-symbol/"
                    },
                    {
                        title: "高気圧と低気圧の違い",
                        url: "https://hario-science.com/low-pressure-high-pressure/"
                    },
                    {
                        title: "気圧（大気圧）とは",
                        url: "https://hario-science.com/atmospheric-pressure/"
                    },
                    {
                        title: "等圧線の読み取りと気圧",
                        url: "https://hario-science.com/isobars/"
                    }
                ]
            }
        ]
    },
    {
        id: 2,
        number: "2",
        title: "【時間的視点】気温・湿度・気圧のグラフの読み取り方",
        badge: "グラフ分析",
        desc: "1日の中での気温と湿度の逆位相の動き（日変化）や、前線通過・天候急変時の急激な気圧・気温の変化を複合グラフから読み解きます。",
        resources: [
            {
                type: "video",
                siteName: "授業アーカイブ",
                badge: "授業動画",
                icon: "🎥",
                desc: "複合グラフから天気の変化を分析するコツ",
                links: [
                    {
                        title: "グラフの読み取り方（授業動画）",
                        url: "https://drive.google.com/file/d/1PCIqGczLCLe3DIqe_YUDXbV75RwPBixc/view?usp=drive_link"
                    }
                ]
            },
            {
                type: "sawanii",
                siteName: "さわにいの理科サイト",
                badge: "さわにい",
                icon: "👨‍🏫",
                desc: "気温・湿度のグラフ変化の徹底比較",
                links: []
            },
            {
                type: "furikaeru",
                siteName: "理科の授業をふりかえる",
                badge: "理科の授業をふりかえる",
                icon: "🎬",
                desc: "乾湿計の使い方や気象観測データのグラフ化",
                links: [
                    {
                        title: "気象の観測（乾湿計・湿度などの測定）",
                        url: "https://hario-science.com/weather-measurement/"
                    }
                ]
            }
        ]
    },
    {
        id: 3,
        number: "3",
        title: "【空間的視点】天気図の読み取り方1（気団、前線、温帯低気圧）",
        badge: "前線・低気圧",
        desc: "日本付近の高気圧・低気圧、寒冷前線・温暖前線の立体構造と、前線通過に伴う風向きや雨の変化を空間的に理解します。",
        resources: [
            {
                type: "video",
                siteName: "授業アーカイブ",
                badge: "授業動画",
                icon: "🎥",
                desc: "前線の立体構造と温帯低気圧の解説",
                links: [
                    {
                        title: "天気図の読み取り方1（授業動画）",
                        url: "https://drive.google.com/file/d/1rSmqqLDStvA6wmB16MMo8i5eNIrmhrOW/view?usp=drive_link"
                    }
                ]
            },
            {
                type: "sawanii",
                siteName: "さわにいの理科サイト",
                badge: "さわにい",
                icon: "👨‍🏫",
                desc: "寒冷前線・温暖前線・閉そく前線を図解で理解",
                links: [
                    {
                        title: "前線の種類と天気の変化",
                        url: "https://sawanii.ne.jp/front/"
                    }
                ]
            },
            {
                type: "furikaeru",
                siteName: "理科の授業をふりかえる",
                badge: "理科の授業をふりかえる",
                icon: "🎬",
                desc: "前線通過に伴う雨や気温の変化を詳しく解説",
                links: [
                    {
                        title: "前線と天気の変化",
                        url: "https://hario-science.com/front-line/"
                    }
                ]
            }
        ]
    },
    {
        id: 4,
        number: "4",
        title: "【空間的視点】天気図の読み取り方2（四季による天気図の違い）",
        badge: "四季の気圧配置",
        desc: "春・梅雨・夏・秋・冬（西高東低、南高北低、移動性高気圧など）の季節ごとの気圧配置の特徴と、日本各地の天候パターンを学びます。",
        resources: [
            {
                type: "video",
                siteName: "授業アーカイブ",
                badge: "授業動画",
                icon: "🎥",
                desc: "日本の四季と気圧配置の解説",
                links: [
                    {
                        title: "天気図の読み取り方2（授業動画）",
                        url: "https://drive.google.com/file/d/1PY3VCtveek_9mGJ120RlxiylRcjjY5Sy/view?usp=drive_link"
                    }
                ]
            },
            {
                type: "sawanii",
                siteName: "さわにいの理科サイト",
                badge: "さわにい",
                icon: "👨‍🏫",
                desc: "シベリア気団・小笠原気団など4つの気団の特徴",
                links: [
                    {
                        title: "日本のまわりの気団と季節の天気",
                        url: "https://sawanii.ne.jp/air-mass/"
                    }
                ]
            },
            {
                type: "furikaeru",
                siteName: "理科の授業をふりかえる",
                badge: "理科の授業をふりかえる",
                icon: "🎬",
                desc: "日本の四季に影響を与える4つの気団まとめ",
                links: [
                    {
                        title: "日本の四季と4つの気団",
                        url: "https://hario-science.com/four-air-groups/"
                    }
                ]
            }
        ]
    },
    {
        id: 5,
        number: "5",
        title: "雲ができる仕組みと水の循環（メカニズム編）",
        badge: "雲・露点・循環",
        desc: "空気が上昇して膨張し、温度が下がって凝結する（露点）プロセスや、雨・雪が降るメカニズム、地球規模の水のめぐりを解明します。",
        resources: [
            {
                type: "video",
                siteName: "授業アーカイブ",
                badge: "授業動画",
                icon: "🎥",
                desc: "空気の上昇と断熱膨張、雲の発生実験の解説",
                links: [
                    {
                        title: "雲ができる仕組み（授業動画）",
                        url: "https://drive.google.com/file/d/1UAMQhIr9Ds197pDpjJM8V2IbLRGaGuVp/view?usp=drive_link"
                    }
                ]
            },
            {
                type: "sawanii",
                siteName: "さわにいの理科サイト",
                badge: "さわにい",
                icon: "👨‍🏫",
                desc: "飽和水蒸気量・露点・雲ができる仕組み",
                links: [
                    {
                        title: "雲ができる仕組みと理由（露点・飽和水蒸気量）",
                        url: "https://sawanii.ne.jp/cloud/"
                    }
                ]
            },
            {
                type: "furikaeru",
                siteName: "理科の授業をふりかえる",
                badge: "理科の授業をふりかえる",
                icon: "🎬",
                desc: "雲ができる仕組みと上昇気流・気圧の変化",
                links: [
                    {
                        title: "雲ができる仕組み（上昇気流と断熱膨張）",
                        url: "https://hario-science.com/how-to-make-clouds/"
                    }
                ]
            }
        ]
    }
];

function initTopicsLearning() {
    renderTopicsLearningSection();
}

function renderTopicsLearningSection() {
    const container = document.getElementById('topicsContainer');
    if (!container) return;

    container.innerHTML = '';

    learningTopicsData.forEach((topic, tIdx) => {
        const item = document.createElement('div');
        item.className = 'topic-accordion-item' + (tIdx === 0 ? ' active' : '');

        const resCardsHtml = topic.resources.map(res => {
            let linksHtml = '';
            if (res.links && res.links.length > 0) {
                if (res.links.length === 1) {
                    const singleLink = res.links[0];
                    linksHtml = `
                        <div class="res-action">
                            <a href="${escapeHtml(singleLink.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-sm btn-res-link-primary">
                                <span>${escapeHtml(singleLink.title)}</span> ↗
                            </a>
                        </div>
                    `;
                } else {
                    const listItems = res.links.map(link => `
                        <li class="res-sublink-item">
                            <a href="${escapeHtml(link.url)}" target="_blank" rel="noopener noreferrer" class="res-sublink-btn">
                                <span class="sublink-title">${escapeHtml(link.title)}</span>
                                <span class="sublink-arrow">↗</span>
                            </a>
                        </li>
                    `).join('');

                    linksHtml = `
                        <div class="res-sublinks-wrapper">
                            <div class="res-sublinks-header">
                                <span class="res-sublinks-count">${res.links.length}つの個別ページ</span>
                            </div>
                            <ul class="res-sublink-list">
                                ${listItems}
                            </ul>
                        </div>
                    `;
                }
            } else {
                linksHtml = `
                    <div class="res-action res-action-empty">
                        <span class="res-empty-badge">⏳ リンク準備中</span>
                    </div>
                `;
            }

            return `
                <div class="topic-res-card res-type-${res.type}">
                    <div class="res-card-top">
                        <span class="res-badge res-badge-${res.type}">${escapeHtml(res.badge)}</span>
                        <span class="res-icon">${res.icon}</span>
                    </div>
                    <h5 class="res-title">${escapeHtml(res.siteName)}</h5>
                    <p class="res-desc">${escapeHtml(res.desc)}</p>
                    ${linksHtml}
                </div>
            `;
        }).join('');

        item.innerHTML = `
            <div class="topic-header" onclick="toggleTopicAccordion(${tIdx})">
                <div class="topic-header-left">
                    <span class="topic-number">第${topic.number}テーマ</span>
                    <h4 class="topic-title">${escapeHtml(topic.title)}</h4>
                    <span class="topic-badge">${escapeHtml(topic.badge)}</span>
                </div>
                <span class="topic-arrow">▼</span>
            </div>
            <div class="topic-body">
                <p class="topic-intro">${escapeHtml(topic.desc)}</p>
                <div class="topic-res-grid">
                    ${resCardsHtml}
                </div>
            </div>
        `;

        container.appendChild(item);
    });
}

function toggleTopicAccordion(index) {
    const items = document.querySelectorAll('.topic-accordion-item');
    if (items[index]) {
        items[index].classList.toggle('active');
    }
}
window.toggleTopicAccordion = toggleTopicAccordion;

// ==========================================================================
// 12. 気象予報士 茂木さんへの質問マネージャー (Q&A管理)
// ==========================================================================

const STORAGE_KEY_MOGI_QA = 'weather_portal_mogi_qa';

// デフォルトQ&Aデータ（代表的なサンプル質問＆茂木さんからの回答）
const defaultMogiQAData = [
    {
        id: 1,
        category: "番組づくり",
        questioner: "中2 生徒",
        question: "お天気番組をつくるときに、視聴者に一番伝わりやすくするためのコツは何ですか？",
        answer: "「専門用語をそのまま言わず、日常の言葉や身近な生活シーンに言い換えること」です！\n\n例えば『寒冷前線が通過します』だけだと難しく感じますが、『午後は急に冷たい北風が吹いて、激しい雨がザッと降ります。折りたたみ傘よりもレインコートや長靴が安心です』のように、視聴者が『じゃあ自分はどう行動すればいいか』を具体的にイメージできるように伝えるのがプロのコツですよ。",
        date: "2026/09/16"
    },
    {
        id: 2,
        category: "天気図の読み方",
        questioner: "気象探究チーム",
        question: "等圧線が狭くなっているところと広いところでは、風の強さはどう違いますか？",
        answer: "等圧線が狭い（混んでいる）ところほど気圧の傾きが急で、強い風が吹き荒れます！\n\n山の地図で言うと『等高線が狭い＝急な崖・坂道』のようなイメージですね。空気が崖を一気に転がり落ちるように勢いよく流れます。逆に等圧線が広いところは風が穏やかで、天候も比較的安定しやすいです。",
        date: "2026/09/18"
    },
    {
        id: 3,
        category: "観天望気",
        questioner: "中2 生徒",
        question: "「夕焼けの次の日は晴れ」というのは、科学的にはどうしてそうなるのですか？",
        answer: "日本の上空では、常に西から東へ偏西風（へんせいふう）が吹いていて、天気も西から東へと移り変わる性質があります。\n\n夕焼けが見えるということは、『西の空に雨雲がなくカラッと晴れている』証拠です。その西の晴れのエリアが翌日自分たちの頭上へやってくるため、次の日も晴れる確率が高いのです！昔の人は科学の知識がなくても、経験からこの法則に気づいていたんですね。",
        date: "2026/09/20"
    }
];

function getMogiQAData() {
    try {
        const stored = localStorage.getItem(STORAGE_KEY_MOGI_QA);
        if (stored) {
            return JSON.parse(stored);
        }
    } catch (e) {
        console.warn('LocalStorage error:', e);
    }
    return defaultMogiQAData;
}

function saveMogiQAData(data) {
    try {
        localStorage.setItem(STORAGE_KEY_MOGI_QA, JSON.stringify(data));
    } catch (e) {
        console.warn('LocalStorage save error:', e);
    }
}

function initMogiQAManager() {
    renderMogiQASection();
}

function renderMogiQASection() {
    const container = document.getElementById('qaListContainer');
    const badge = document.getElementById('qaCountBadge');
    if (!container) return;

    const data = getMogiQAData();
    if (badge) badge.textContent = `全${data.length}件`;

    container.innerHTML = '';

    if (data.length === 0) {
        container.innerHTML = `
            <div class="qa-empty">
                <p>現在登録されているQ&Aはありません。「Google Docs を開く」から質問を投稿するか、先生用モードで追加してください。</p>
            </div>
        `;
        return;
    }

    data.forEach((item, index) => {
        const card = document.createElement('div');
        card.className = 'qa-card';

        let adminActionsHtml = '';
        if (isScheduleAdmin) {
            adminActionsHtml = `
                <div class="qa-admin-actions">
                    <button class="btn-icon-action btn-edit" onclick="openQAModal(${index})" title="編集">✏️ 編集</button>
                    <button class="btn-icon-action btn-delete" onclick="deleteQAItem(${index})" title="削除">🗑️ 削除</button>
                </div>
            `;
        }

        // 回答テキスト内の改行を反映
        const formattedAnswer = escapeHtml(item.answer).replace(/\n/g, '<br>');

        card.innerHTML = `
            <div class="qa-card-header">
                <div class="qa-meta-left">
                    <span class="qa-category-tag">${escapeHtml(item.category || '気象の疑問')}</span>
                    <span class="qa-questioner">${escapeHtml(item.questioner || '生徒からの質問')}</span>
                </div>
                <div class="qa-meta-right">
                    ${item.date ? `<span class="qa-date">${escapeHtml(item.date)}</span>` : ''}
                    ${adminActionsHtml}
                </div>
            </div>
            
            <div class="qa-question-box">
                <div class="qa-q-badge">Q</div>
                <div class="qa-q-text">
                    <h4>${escapeHtml(item.question)}</h4>
                </div>
            </div>

            <div class="qa-answer-box">
                <div class="qa-expert-avatar">
                    <span class="avatar-icon">👨‍💼</span>
                    <span class="avatar-name">茂木さん</span>
                </div>
                <div class="qa-a-speech">
                    <div class="qa-a-header">気象予報士 茂木さんからの回答・アドバイス：</div>
                    <p class="qa-a-text">${formattedAnswer}</p>
                </div>
            </div>
        `;

        container.appendChild(card);
    });
}

function openQAModal(index = -1) {
    const backdrop = document.getElementById('modalQABackdrop');
    const titleEl = document.getElementById('qaModalTitle');
    const idxInput = document.getElementById('qaEditIndex');
    const catInput = document.getElementById('qaCategory');
    const qerInput = document.getElementById('qaQuestioner');
    const qInput = document.getElementById('qaQuestion');
    const aInput = document.getElementById('qaAnswer');

    if (!backdrop) return;

    if (index >= 0) {
        const data = getMogiQAData();
        const item = data[index];
        titleEl.textContent = 'Q&Aを編集';
        idxInput.value = index;
        catInput.value = item.category || '';
        qerInput.value = item.questioner || '';
        qInput.value = item.question || '';
        aInput.value = item.answer || '';
    } else {
        titleEl.textContent = 'Q&Aを新規追加';
        idxInput.value = -1;
        catInput.value = '番組づくり';
        qerInput.value = '2年生 生徒';
        qInput.value = '';
        aInput.value = '';
    }

    backdrop.style.display = 'flex';
}
window.openQAModal = openQAModal;

function closeQAModal() {
    const backdrop = document.getElementById('modalQABackdrop');
    if (backdrop) backdrop.style.display = 'none';
}
window.closeQAModal = closeQAModal;

function saveQAItem() {
    const idx = parseInt(document.getElementById('qaEditIndex').value, 10);
    const category = document.getElementById('qaCategory').value.trim() || '気象の疑問';
    const questioner = document.getElementById('qaQuestioner').value.trim() || '生徒';
    const question = document.getElementById('qaQuestion').value.trim();
    const answer = document.getElementById('qaAnswer').value.trim();

    if (!question || !answer) {
        alert('質問内容と回答内容は必須入力です。');
        return;
    }

    const today = new Date();
    const dateStr = `${today.getFullYear()}/${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}`;

    const item = {
        id: Date.now(),
        category,
        questioner,
        question,
        answer,
        date: dateStr
    };

    const data = [...getMogiQAData()];
    if (idx >= 0 && idx < data.length) {
        item.id = data[idx].id;
        item.date = data[idx].date || dateStr;
        data[idx] = item;
    } else {
        data.unshift(item); // 新しいものを先頭に
    }

    saveMogiQAData(data);
    closeQAModal();
    renderMogiQASection();
    showToast('Q&Aを保存しました');
}
window.saveQAItem = saveQAItem;

function deleteQAItem(index) {
    const data = getMogiQAData();
    if (!data[index]) return;
    if (confirm(`このQ&Aを削除してもよろしいですか？\n\n質問: ${data[index].question.substring(0, 30)}...`)) {
        const newData = data.filter((_, i) => i !== index);
        saveMogiQAData(newData);
        renderMogiQASection();
        showToast('Q&Aを削除しました');
    }
}
window.deleteQAItem = deleteQAItem;

function exportQACode() {
    const data = getMogiQAData();
    const jsonStr = JSON.stringify(data, null, 4);
    navigator.clipboard.writeText(jsonStr).then(() => {
        showToast('Q&Aデータをクリップボードにコピーしました！コードに貼り付け可能です');
    }).catch(() => {
        prompt('以下のJSONデータをコピーして保存してください:', jsonStr);
    });
}
window.exportQACode = exportQACode;

function resetQAData() {
    if (confirm('Q&Aを初期状態に戻しますか？（現在の編集内容は上書きされます）')) {
        saveMogiQAData(defaultMogiQAData);
        renderMogiQASection();
        showToast('Q&Aを初期データにリセットしました');
    }
}
window.resetQAData = resetQAData;

// ==========================================================================
// 13. 共通ユーティリティ (トースト通知 & HTMLエスケープ)
// ==========================================================================

function showToast(message, isSuccess = true) {
    const toast = document.getElementById('toastNotification');
    const toastText = document.getElementById('toastText');
    if (!toast || !toastText) return;

    toastText.textContent = message;
    toast.className = 'toast-notification' + (isSuccess ? ' toast-success' : ' toast-error');
    toast.style.display = 'flex';

    setTimeout(() => {
        toast.classList.add('show');
    }, 10);

    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => {
            toast.style.display = 'none';
        }, 300);
    }, 3200);
}
window.showToast = showToast;

function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

