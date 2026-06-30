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
// 1. 起動時の初期化
// ==========================================================================
window.addEventListener('DOMContentLoaded', () => {
    initEventListeners();
    loadDefaultData();
    updateLocationDisplay();
});

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

        const typedarray = new Uint8Array(arrayBuffer);
        const pdfDoc = await pdfjsLib.getDocument({ data: typedarray }).promise;

        // 既存のスロットがあれば更新、なければ追加
        const pdfInfo = {
            slot: slotNum,
            name: file.name,
            year: ym ? ym.year : null,
            month: ym ? ym.month : null,
            pdfDoc: pdfDoc
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

        if (pageNum < 1 || pageNum > pdfDoc.numPages) {
            console.warn(`Page ${pageNum} is out of range for PDF`);
            return;
        }

        const page = await pdfDoc.getPage(pageNum);
        // 高画質でレンダリングするため scale = 2.5 とする
        const scale = 2.5;
        const viewport = page.getViewport({ scale: scale });

        // 一時的なテンポラリCanvasを作成してページ全体をレンダリングする
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = viewport.width;
        tempCanvas.height = viewport.height;
        const tempCtx = tempCanvas.getContext('2d');

        const renderContext = {
            canvasContext: tempCtx,
            viewport: viewport
        };
        await page.render(renderContext).promise;

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

        const sx = gridX + col * cellW;
        const sy = gridY + row * cellH;

        // 天気図部分を切り出す。
        // 天気図のみ(text)モード: 下部の概況文章部分をカットするため、高さをセルの約73%にする
        // 画像丸ごと(image)モード: セル全体を切り取るため、高さ100%にする
        const sw = cellW;
        const sh = state.displayMode === "image" ? cellH : cellH * 0.73; 

        // 境界カット幅（スライダー値）
        const pad = settings.pad;

        // メインCanvasのサイズを切り出しサイズに合わせる
        canvas.width = sw - pad * 2;
        canvas.height = sh - pad * 2;

        // 切り出してコピー描画
        ctx.drawImage(tempCanvas, sx + pad, sy + pad, sw - pad * 2, sh - pad * 2, 0, 0, canvas.width, canvas.height);

        const dataUrl = canvas.toDataURL('image/png');
        state.dayNotes[dayIdx].mapSrc = dataUrl;
        if (imgEl) imgEl.src = dataUrl;

        // ワークシートのUI表示モード用クラス切り替え
        if (chartItem) {
            if (state.displayMode === "image") {
                chartItem.classList.add('display-mode-image');
            } else {
                chartItem.classList.remove('display-mode-image');
            }
        }

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
// 棒は上向き(0, -7)から(0, -24)へ伸びています。
// 羽は棒の右側に向けて、先端側から順に描きます。
function drawWindFeathers(group, force) {
    const featherAngle = 60; // 棒に対する角度 (右に傾ける)
    const rad = (featherAngle * Math.PI) / 180;
    
    // 羽を描画するY座標のリスト (先端側から下へ並べる)
    const yStarts = [-24, -21.5, -19, -16.5, -14, -11.5];
    
    let fCount = force;
    let idx = 0;

    // 長い羽は風力2相当、短い羽は風力1相当
    while (fCount > 0) {
        const yStart = yStarts[idx];
        if (yStart === undefined) break;

        const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line.setAttribute('x1', 0);
        line.setAttribute('y1', yStart);

        let length = 6.5; // 長い羽
        if (fCount === 1) {
            length = 3.5; // 短い羽
            fCount -= 1;
        } else {
            fCount -= 2; // 長い羽は風力2を引く
        }

        // 先端から羽を伸ばす (右上へ上上がりに)
        const xEnd = length * Math.sin(rad);
        const yEnd = yStart - length * Math.cos(rad); // 上上がりにするため、さらに上（マイナス方向）に向けて伸ばす

        line.setAttribute('x2', xEnd);
        line.setAttribute('y2', yEnd);
        line.setAttribute('stroke', '#333333');
        line.setAttribute('stroke-width', '1.2');
        group.appendChild(line);

        idx++;
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


