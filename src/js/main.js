import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-analytics.js";
import {
    getDatabase,
    ref,
    query,
    orderByChild,
    limitToLast,
    get,
    set,
    update,
    onValue,
    push,
    off,
    runTransaction
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";
import {
    getAuth,
    GoogleAuthProvider,
    signInWithPopup,
    signInWithRedirect,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    updateProfile,
    signOut,
    onAuthStateChanged,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

import { firebaseConfig } from './config.js';
import { SUBJECT_DATA } from './subjects.js';
import { startFlashcardQuiz, resumeFlashcardQuiz } from './flashcard.js';
import { startMultipleChoiceQuiz, resumeMultipleChoiceQuiz } from './multiple-choice.js';

let isComposing = false;
let mistakesCount = [];
let unitStars = [];
let currentQuestionAccuracyText = "N/A";
let currentQuestionCorrectCount = 0;
let currentQuestionTotalCount = 0;
const statsCache = new Map();
let currentSubject = null;
let currentUnitUrl = null;
let currentUnitName = null;
let currentJsonPath = null;
let currentSelectedUnitName = null;
let endRoundTimeout = null;

document.addEventListener('compositionstart', () => { isComposing = true; });
document.addEventListener('compositionend', () => { isComposing = false; });



const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const db = getDatabase(app);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

function isAllowedEmail(email) {
    if (!email) return false;
    const lowerEmail = email.toLowerCase();
    if (!lowerEmail.endsWith('@g.ntu.edu.tw')) return false;
    const prefix = lowerEmail.split('@')[0];
    return prefix.substring(3, 6) === '401';
}

async function loadAllJsonData() {
    const files = ['D.json', 'I.json', 'L.json', 'O.json', 'R.json', 'S.json', 'U.json'];
    let allData = [];
    for (const file of files) {
        try {
            const data = await new Promise((resolve, reject) => {
                $.getJSON(file).done(resolve).fail(reject);
            });
            if (Array.isArray(data)) {
                allData = allData.concat(data);
            }
        } catch (e) {
            console.error(`Failed to load ${file}`, e);
        }
    }
    return allData;
}

function buildUnitJsonPath(baseUrl, unitId) {
    const base = `.${baseUrl}`;
    let rawId = String(unitId || "").trim();
    if (!rawId) return `${base}/JSON/`;
    let normalizedId = rawId.replace(/^\.?\//, '');
    if (!normalizedId.endsWith('.json')) {
        normalizedId += '.json';
    }
    if (normalizedId.startsWith('JSON/')) {
        return `${base}/${normalizedId}`;
    }
    return `${base}/JSON/${normalizedId}`;
}

async function loadAllSubjectData(baseUrl) {
    try {
        const res = await fetch(`.${baseUrl}/unit.json`);
        if (!res.ok) throw new Error('Network response was not ok');
        const units = await res.json();
        let allData = [];
        for (const unit of units) {
            try {
                const unitJsonPath = buildUnitJsonPath(baseUrl, unit.id);
                const unitData = await new Promise((resolve, reject) => {
                    $.getJSON(unitJsonPath).done(resolve).fail(reject);
                });
                if (Array.isArray(unitData)) {
                    const enrichedData = unitData.map(item => ({ ...item, baseUrl: `.${baseUrl}` }));
                    allData = allData.concat(enrichedData);
                }
            } catch (e) { console.error(`Failed to load ${unit.id}`, e); }
        }
        return allData;
    } catch (e) {
        console.error('Failed to load all data for', baseUrl, e);
        return [];
    }
}

function createStartHandler(jsonPath, explicitUnitName = null) {
    return async function () {
        console.log(`[createStartHandler] Starting game with ${jsonPath}`);

        const currentUser = auth.currentUser || (window.currentUserUid ? { uid: window.currentUserUid, email: "test@g.ntu.edu.tw", displayName: window.currentPlayer } : null);
        if (!currentUser) {
            showAlertModal("請先登入！");
            window.gameplayActive = false;
            return;
        }

        const userEmail = currentUser.email || '';
        if (!isAllowedEmail(userEmail)) {
            showAlertModal('請使用醫學系 @g.ntu.edu.tw 帳號登入以使用本系統');
            window.gameplayActive = false;
            return;
        }

        if (endRoundTimeout) clearTimeout(endRoundTimeout);

        window.currentPlayer = (currentUser.displayName || currentUser.email || "使用者");
        window.gameplayActive = true;

        const header = document.getElementById('mainHeader');
        if (header) header.style.display = 'none';
        document.querySelector('.start-screen').style.display = 'none';
        document.querySelector('.flashcard-container').style.display = 'flex';

        sessionCorrect = 0;
        sessionWrong = 0;
        document.getElementById("correct").innerHTML = "0";
        document.getElementById("wrong").innerHTML = "0";
        updateScoreDisplay();
        correctList = []; wrongList = [];

        const nextBtn = document.getElementById('next');
        nextBtn.innerText = "下題";
        nextBtn.style.display = 'block';
        nextBtn.removeEventListener('click', startReviewWrong);
        nextBtn.removeEventListener('click', nextProb);
        nextBtn.addEventListener('click', nextProb);

        try {
            if (explicitUnitName) {
                window.currentUnitName = explicitUnitName;
            } else {
                const clickedItem = Array.from(document.querySelectorAll('.dropdown-item'))
                    .find(el => el.dataset.json === jsonPath);
                if (clickedItem) {
                    window.currentUnitName = clickedItem.textContent.trim();
                } else {
                    if (jsonPath === 'all') {
                        window.currentUnitName = '全部';
                    } else {
                        window.currentUnitName = jsonPath.split('/')?.pop()?.replace(/\.json$/, '') || '單元';
                    }
                }
            }
            window.currentJsonPath = jsonPath;
        } catch (_) {
            window.currentUnitName = explicitUnitName || '單元';
            window.currentJsonPath = jsonPath;
        }

        document.title = `${window.currentUnitName} ｜ 臺大醫跑臺機`;

        try {
            let jsonData;
            if (jsonPath.startsWith('all:')) {
                const baseUrl = jsonPath.split(':')[1];
                window.currentBaseUrl = '.' + baseUrl;
                jsonData = await loadAllSubjectData(baseUrl);
            } else if (jsonPath === 'all') {
                window.currentBaseUrl = '.';
                jsonData = await loadAllJsonData();
            } else {
                jsonData = await new Promise((resolve, reject) => {
                    $.getJSON(jsonPath).done(resolve).fail(reject);
                });
                let baseUrl = '.';
                if (jsonPath.includes('/JSON/')) {
                    baseUrl = jsonPath.split('/JSON/')[0];
                }
                window.currentBaseUrl = baseUrl;
                jsonData = jsonData.map(item => ({ ...item, baseUrl }));
            }

            data = jsonData;
            numOfProbs = data.length;
            if (numOfProbs === 0) throw new Error("No data loaded from JSON.");
            data = parseMultiAns(data);
            done = new Array(numOfProbs).fill(false);
            mistakesCount = await loadUnitMistakesFromFirebase(numOfProbs, window.currentJsonPath);
            unitStars = await loadUnitStarsFromFirebase(numOfProbs, window.currentJsonPath);
            updateStarButtonState();
            resetPreloadState();
            const isMultipleChoice = (data.length > 0 && data[0].options !== undefined);
            initializeQuestionQueue(isMultipleChoice); // pass true to keep sequential order
            if (isMultipleChoice) {
                startMultipleChoiceQuiz(data, window.currentJsonPath, window.currentUnitName);
            } else {
                startFlashcardQuiz(data, window.currentJsonPath, window.currentUnitName);
            }
        } catch (error) {
            console.error("Error processing JSON data:", error);
            showAlertModal("無法讀取遊戲資料");
            window.gameplayActive = false;
            document.querySelector('.start-screen').style.display = '';
            document.querySelector('.flashcard-container').style.display = 'none';
        }
    };
}

function selectModalUnit(unit, baseUrl, btnEl) {
    if (unit.id === 'all') {
        currentUnitUrl = `all:${baseUrl}`;
    } else {
        currentUnitUrl = buildUnitJsonPath(baseUrl, unit.id);
    }
    currentSelectedUnitName = unit.name;

    document.querySelectorAll('#unitModalList button').forEach(b => {
        b.classList.remove('border-[var(--accent-blue)]', 'bg-[var(--focus-ring)]');
        b.classList.add('border-[var(--border-primary)]');
    });

    btnEl.classList.add('border-[var(--accent-blue)]', 'bg-[var(--focus-ring)]');
    btnEl.classList.remove('border-[var(--border-primary)]');

    const startBtn = document.getElementById('modalStartQuizBtn');
    const tikuBtn = document.getElementById('modalOpenDocBtn');

    startBtn.disabled = false;
    startBtn.classList.remove('opacity-50', 'cursor-not-allowed');

    tikuBtn.textContent = "單元複習";
    tikuBtn.disabled = false;
    tikuBtn.classList.remove('opacity-50', 'cursor-not-allowed');
}

function detectUserYear() {
    if (!auth.currentUser || !auth.currentUser.email) return null;
    const email = auth.currentUser.email.toLowerCase();
    const match = email.match(/b(\d{2})/);
    if (!match) return null;

    const yearPrefix = parseInt(match[1]);
    const admissionYearAD = 1911 + 100 + yearPrefix;
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentAcademicYear = currentMonth >= 7 ? currentYear : currentYear - 1;
    const yearNum = currentAcademicYear - admissionYearAD + 1;

    const yearLabels = ["一年級", "二年級", "三年級", "四年級", "五年級", "六年級", "七年級"];
    if (yearNum >= 1 && yearNum <= 7) {
        return yearLabels[yearNum - 1];
    }
    return null;
}

async function openUnitModal(subject) {
    currentSubject = subject;
    currentUnitUrl = null;
    currentSelectedUnitName = null;

    const modal = document.getElementById('unitSelectionModal');
    const title = document.getElementById('unitModalTitle');
    const list = document.getElementById('unitModalList');
    const startBtn = document.getElementById('modalStartQuizBtn');
    const tikuBtn = document.getElementById('modalOpenDocBtn');

    if (title) title.textContent = `${subject.title}`;
    if (list) list.innerHTML = '<p class="text-center text-gray-500 my-4">載入單元中...</p>';
    if (startBtn) {
        startBtn.disabled = true;
        startBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
    if (tikuBtn) {
        tikuBtn.disabled = true;
        tikuBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }

    if (modal) modal.style.display = 'flex';

    if (subject.url === '#') {
        if (list) list.innerHTML = '<p class="text-center text-gray-500 my-4">尚無單元資料</p>';
        return;
    }

    const prog = await loadProgressFromFirebase();

    try {
        const res = await fetch(`.${subject.url}/unit.json`);
        if (!res.ok) throw new Error('Network response was not ok');
        const units = await res.json();

        if (list) {
            list.innerHTML = '';

            if (prog) {
                const total = Array.isArray(prog.data) ? prog.data.length : 0;
                const completed = Array.isArray(prog.done) ? prog.done.filter(Boolean).length : 0;
                const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

                const progressBlock = document.createElement('div');
                progressBlock.className = 'p-5 bg-[var(--md-sys-color-primary-container)] border border-[var(--md-sys-color-primary)] border-opacity-20 rounded-2xl shadow-sm';
                progressBlock.innerHTML = `
                    <div class="flex justify-between items-center mb-3">
                        <div class="flex items-center gap-2">
                            <i data-lucide="history" class="w-4 h-4 text-[var(--accent-blue)]"></i>
                            <span class="text-sm font-bold text-[var(--accent-blue)]">上次進度：${prog.unitName || '單元'}</span>
                        </div>
                        <span class="text-xs font-black text-white bg-[var(--accent-blue)] px-2 py-1 rounded-full">${percent}%</span>
                    </div>
                    <div class="h-2 bg-white bg-opacity-50 rounded-full overflow-hidden mb-5">
                        <div class="h-full bg-[var(--accent-blue)] transition-all duration-700" style="width: ${percent}%"></div>
                    </div>
                    <div class="flex gap-3">
                        <button id="modalResumeBtn" class="flex-1 py-3 bg-[var(--accent-blue)] text-white rounded-xl text-sm font-bold hover:brightness-110 transition-all active:scale-95 shadow-lg shadow-blue-900/10 flex items-center justify-center gap-2">
                            <i data-lucide="play" class="w-4 h-4"></i>
                            <span>接續上次</span>
                        </button>
                        <button id="modalRestartBtn" class="flex-1 py-3 bg-white text-red-500 border border-red-50 rounded-xl text-sm font-bold hover:bg-red-50 transition-all active:scale-95 flex items-center justify-center gap-2">
                            <i data-lucide="rotate-ccw" class="w-4 h-4"></i>
                            <span>重新開始</span>
                        </button>
                    </div>
                `;
                list.appendChild(progressBlock);

                document.getElementById('modalResumeBtn').onclick = () => {
                    document.getElementById('unitSelectionModal').style.display = 'none';
                    document.getElementById('resumeButton').click();
                };
                document.getElementById('modalRestartBtn').onclick = () => {
                    if (confirm('確定要刪除此科目的所有目前進度並重新開始嗎？')) {
                        document.getElementById('restartProgress').click();
                        setTimeout(() => openUnitModal(subject), 500);
                    }
                };

                const divider = document.createElement('div');
                divider.className = 'flex items-center gap-3 my-6 opacity-40';
                divider.innerHTML = '<hr class="flex-grow border-gray-300"><span class="text-[10px] font-bold text-gray-500 uppercase tracking-widest font-[\'Outfit\']">所有單元</span><hr class="flex-grow border-gray-300">';
                list.appendChild(divider);
            }

            const listContainer = document.createElement('div');
            listContainer.className = 'flex flex-col gap-2 w-full';

            const unitWithCounts = await Promise.all(units.map(async (unit) => {
                let questionCount = 0;
                try {
                    const unitRes = await fetch(buildUnitJsonPath(subject.url, unit.id));
                    if (unitRes.ok) {
                        const unitData = await unitRes.json();
                        questionCount = Array.isArray(unitData) ? unitData.length : 0;
                    }
                } catch (e) { console.warn(`Failed count for ${unit.id}`, e); }
                return { ...unit, questionCount };
            }));

            const totalQuestionCount = unitWithCounts.reduce((sum, unit) => sum + (Number(unit.questionCount) || 0), 0);

            const allUnitsBtn = document.createElement('button');
            allUnitsBtn.className = 'group w-full text-left px-5 py-4 rounded-2xl border border-[var(--border-primary)] hover:border-[var(--accent-blue)] hover:bg-[var(--md-sys-color-primary-container)] transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] text-[var(--text-primary)] relative overflow-hidden';
            allUnitsBtn.innerHTML = `
                <div class="flex items-center justify-between gap-3 relative z-10">
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-[var(--text-primary)] group-hover:text-[var(--accent-blue)] transition-colors">全部</div>
                        <div class="text-xs text-[var(--text-secondary)] mt-1 opacity-70 truncate">整科所有單元</div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                        <span class="shrink-0 inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border border-[var(--border-secondary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] group-hover:border-[var(--accent-blue)] group-hover:text-[var(--accent-blue)] transition-all">
                            ${totalQuestionCount} 題
                        </span>
                    </div>
                </div>
            `;
            allUnitsBtn.onclick = (e) => selectModalUnit({ id: 'all', name: '全部' }, subject.url, e.currentTarget);
            listContainer.appendChild(allUnitsBtn);

            unitWithCounts.forEach(unit => {
                const btn = document.createElement('button');
                btn.className = 'group w-full text-left px-5 py-4 rounded-2xl border border-[var(--border-primary)] hover:border-[var(--accent-blue)] hover:bg-[var(--md-sys-color-primary-container)] transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-[var(--focus-ring)] text-[var(--text-primary)] relative overflow-hidden';
                btn.innerHTML = `
                    <div class="flex items-center justify-between gap-3 relative z-10">
                        <div class="flex-1 min-w-0">
                            <div class="font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent-blue)] transition-colors">${unit.name}</div>
                        </div>
                        <div class="flex items-center gap-2 shrink-0">
                            <span class="shrink-0 inline-flex items-center px-3 py-1 rounded-full text-xs font-bold border border-[var(--border-secondary)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] group-hover:border-[var(--accent-blue)] group-hover:text-[var(--accent-blue)] transition-all">
                                ${unit.questionCount} 題
                            </span>
                        </div>
                    </div>
                `;
                btn.onclick = (e) => selectModalUnit(unit, subject.url, e.currentTarget);
                listContainer.appendChild(btn);
            });
            list.appendChild(listContainer);
            if (typeof lucide !== 'undefined') lucide.createIcons();
        }
    } catch (e) {
        console.error('Failed to load unit.json', e);
        if (list) list.innerHTML = '<p class="text-center text-red-500 my-4">獲取單元失敗</p>';
    }
}

function setupTabs() {
    const quizContentContainer = document.getElementById('quiz-content-container');
    if (!quizContentContainer) return;
    quizContentContainer.innerHTML = '';

    const groupedByYear = SUBJECT_DATA.reduce((acc, course) => {
        const year = course.year;
        if (!acc[year]) acc[year] = [];
        acc[year].push(course);
        return acc;
    }, {});

    const detectedYear = detectUserYear();
    const isLoggedIn = !!auth.currentUser;
    let yearOrder = ["一年級", "二年級", "三年級", "四年級", "五年級", "六年級"];

    if (isLoggedIn && detectedYear && yearOrder.includes(detectedYear)) {
        yearOrder = yearOrder.filter(y => y !== detectedYear);
        yearOrder.unshift(detectedYear);
    }

    yearOrder.forEach((year) => {
        if (!groupedByYear[year]) return;
        const yearSection = document.createElement('section');
        yearSection.className = 'mb-6';
        const isTargetYear = isLoggedIn && year === detectedYear;
        const isCollapsedByDefault = isLoggedIn && detectedYear && !isTargetYear;

        const headerWrapper = document.createElement('div');
        headerWrapper.className = `flex items-center justify-between px-4 py-4 rounded-2xl transition-all duration-300 ${isLoggedIn ? 'cursor-pointer hover:bg-[var(--md-sys-color-primary-container)]' : ''}`;

        const yearTitle = document.createElement('h2');
        yearTitle.className = "text-2xl font-bold text-[var(--md-sys-color-primary)] font-['Outfit'] border-l-4 border-[var(--md-sys-color-primary)] pl-4 ml-1";
        yearTitle.textContent = year;
        headerWrapper.appendChild(yearTitle);

        if (isLoggedIn) {
            const chevron = document.createElement('div');
            chevron.className = `transition-transform duration-300 ${isCollapsedByDefault ? '' : 'rotate-180'}`;
            chevron.innerHTML = '<i data-lucide="chevron-down" class="w-6 h-6"></i>';
            headerWrapper.appendChild(chevron);
            headerWrapper.onclick = () => {
                const isHidden = grid.style.display === 'none';
                grid.style.display = isHidden ? 'grid' : 'none';
                chevron.classList.toggle('rotate-180', isHidden);
            };
        }

        yearSection.appendChild(headerWrapper);
        const grid = document.createElement('div');
        grid.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6 fade-in px-4 py-4 mx-auto w-full';
        if (isCollapsedByDefault) grid.style.display = 'none';

        groupedByYear[year].forEach((quiz) => {
            const card = document.createElement('div');
            card.className = "card group p-5 flex flex-col items-center h-full";
            if (quiz.url === "#") {
                card.classList.add("disabled");
            } else {
                card.onclick = () => openUnitModal(quiz);
            }
            card.innerHTML = `
                <div class="p-3 rounded-lg mb-4 icon-container transition-transform duration-300 group-hover:scale-110">
                    <i data-lucide="${quiz.icon}" class="w-7 h-7"></i>
                </div>
                <h3 class="text-lg font-bold flex-grow text-[var(--heading-color)] group-hover:text-[var(--accent-blue)] transition-colors duration-300">
                    ${quiz.title}
                    ${quiz.subtitle ? `<span class="block text-xs font-normal text-[var(--text-secondary)] group-hover:text-[var(--accent-blue)] opacity-80 mt-1 transition-colors duration-300">${quiz.subtitle}</span>` : ''}
                </h3>
                <div class="mt-auto w-full">
                     <div class="w-full bg-[var(--bg-primary)] border border-[var(--border-secondary)] text-[var(--text-secondary)] font-medium py-2.5 px-4 rounded-lg group-hover:bg-[var(--accent-blue)] group-hover:border-[var(--accent-blue)] group-hover:text-white transition-all duration-300 text-center text-sm shadow-sm flex justify-center items-center gap-2 relative">
                        <span class="transition-transform duration-300 group-hover:-translate-x-2">選擇單元</span>
                        <i data-lucide="arrow-right" class="w-4 h-4 opacity-0 scale-0 group-hover:opacity-100 group-hover:scale-100 transition-all duration-300 absolute right-6"></i>
                    </div>
                </div>
            `;
            grid.appendChild(card);
        });
        yearSection.appendChild(grid);
        quizContentContainer.appendChild(yearSection);
    });
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

// Firebase progress management functions
async function checkForExistingProgress() {
    let hasProgress = false;

    if (window.currentUserUid) {
        // Check Firebase first for logged in users
        try {
            const firebaseProgress = await loadProgressFromFirebase();
            if (firebaseProgress) {
                console.log("[checkForExistingProgress] Found progress in Firebase");
                hasProgress = true;
            }
        } catch (error) {
            console.error("[checkForExistingProgress] Error checking Firebase progress:", error);
        }
    }

    // Firebase only

    // Update UI based on progress availability
    if (hasProgress) {
        const resumeEl = document.getElementById('resumeButton');
        const prog = await loadProgressFromFirebase();
        let unitNameText = '單元';
        let percent = 0;
        if (prog && Array.isArray(prog.done) && Array.isArray(prog.data) && prog.data.length > 0) {
            const total = prog.data.length;
            const completed = prog.done.filter(Boolean).length;
            percent = Math.round((completed / total) * 100);
        }
        if (prog && prog.unitName) {
            unitNameText = prog.unitName;
        }
        if (resumeEl) {
            resumeEl.textContent = `繼續 ${unitNameText}`;
            resumeEl.style.display = 'inline-block';
        }
        const resumeProgress = document.getElementById('resumeProgress');
        const fill = document.getElementById('resumeProgressFill');
        const text = document.getElementById('resumeProgressText');
        if (resumeProgress && fill && text) {
            resumeProgress.style.display = 'flex';
            fill.style.width = `${percent}%`;
            text.textContent = `${percent}%`;
        }
        document.querySelector('.progress-actions').style.display = 'block';
    } else {
        const resumeEl = document.getElementById('resumeButton');
        if (resumeEl) resumeEl.style.display = 'none';
        const resumeProgress = document.getElementById('resumeProgress');
        if (resumeProgress) resumeProgress.style.display = 'none';
        document.querySelector('.progress-actions').style.display = 'none';
    }

    return hasProgress;
}

function getSubjectKey(pathOverride) {
    // Derived from pathOverride, currentUnitUrl or currentSubject.url
    let path = pathOverride || "";
    if (!path) {
        if (typeof currentUnitUrl === 'string' && currentUnitUrl) {
            if (currentUnitUrl.startsWith('all:')) {
                path = currentUnitUrl.split(':')[1];
            } else {
                path = currentUnitUrl;
            }
        } else if (currentSubject && currentSubject.url) {
            path = currentSubject.url;
        }
    }

    if (!path) return "histology"; // Default fallback

    // Extract key from path like "/content/y3s1-histology-mid"
    const parts = path.split('/');
    const contentIndex = parts.indexOf('content');
    if (contentIndex !== -1 && parts[contentIndex + 1]) {
        return parts[contentIndex + 1];
    }
    return "histology";
}

function toFirebaseSafeKey(value) {
    if (!value) return "unknown-unit";
    return encodeURIComponent(String(value)).replace(/\./g, "%2E");
}

function mergeMistakesCounts(base, incoming, length) {
    const baseArr = Array.isArray(base) ? base : [];
    const incomingArr = Array.isArray(incoming) ? incoming : [];
    return new Array(length).fill(0).map((_, idx) => {
        const baseVal = Number(baseArr[idx]) || 0;
        const incomingVal = Number(incomingArr[idx]) || 0;
        return Math.max(baseVal, incomingVal);
    });
}

function buildUnitMistakesRef(jsonPathOverride) {
    if (!window.currentUserUid) return null;
    const normalizedPath = jsonPathOverride || window.currentJsonPath || "unknown-unit";
    const category = getSubjectKey(normalizedPath);
    const unitKey = toFirebaseSafeKey(normalizedPath);
    return ref(db, `user-metadata/${window.currentUserUid}/unitMistakes/${category}/${unitKey}`);
}

function buildUnitStarsRef(jsonPathOverride) {
    if (!window.currentUserUid) return null;
    const normalizedPath = jsonPathOverride || window.currentJsonPath || "unknown-unit";
    const category = getSubjectKey(normalizedPath);
    const unitKey = toFirebaseSafeKey(normalizedPath);
    return ref(db, `user-metadata/${window.currentUserUid}/unitStars/${category}/${unitKey}`);
}

async function loadUnitStarsFromFirebase(length, jsonPathOverride) {
    if (!window.currentUserUid) return new Array(length).fill(false);
    try {
        const unitStarsRef = buildUnitStarsRef(jsonPathOverride);
        if (!unitStarsRef) return new Array(length).fill(false);
        const snapshot = await get(unitStarsRef);
        if (snapshot.exists()) {
            let arr = snapshot.val();
            if (!Array.isArray(arr)) arr = [];
            if (arr.length < length) {
                arr = [...arr, ...new Array(length - arr.length).fill(false)];
            }
            return arr.slice(0, length);
        }
    } catch (error) {
        console.error("[loadUnitStarsFromFirebase] Failed to load stars:", error);
    }
    return new Array(length).fill(false);
}

async function saveUnitStarsToFirebase(jsonPathOverride) {
    if (!window.currentUserUid || !Array.isArray(unitStars)) return;
    try {
        const unitStarsRef = buildUnitStarsRef(jsonPathOverride);
        if (!unitStarsRef) return;
        await set(unitStarsRef, unitStars.map(v => !!v));
    } catch (error) {
        console.error("[saveUnitStarsToFirebase] Failed to save stars:", error);
    }
}

async function loadUnitMistakesFromFirebase(length, jsonPathOverride) {
    const fallback = new Array(length).fill(0);
    if (!window.currentUserUid) return fallback;

    try {
        const unitMistakesRef = buildUnitMistakesRef(jsonPathOverride);
        if (!unitMistakesRef) return fallback;
        const snapshot = await get(unitMistakesRef);
        if (!snapshot.exists()) return fallback;
        const stored = snapshot.val();
        const normalized = Array.isArray(stored) ? stored : [];
        return new Array(length).fill(0).map((_, idx) => Number(normalized[idx]) || 0);
    } catch (error) {
        console.error("[loadUnitMistakesFromFirebase] Failed to load mistakes:", error);
        return fallback;
    }
}

async function saveUnitMistakesToFirebase(jsonPathOverride) {
    if (!window.currentUserUid || !Array.isArray(mistakesCount)) return;
    try {
        const unitMistakesRef = buildUnitMistakesRef(jsonPathOverride);
        if (!unitMistakesRef) return;
        await set(unitMistakesRef, mistakesCount.map(v => Number(v) || 0));
    } catch (error) {
        console.error("[saveUnitMistakesToFirebase] Failed to save mistakes:", error);
    }
}

async function saveProgressToFirebase(progressData) {
    if (!window.currentUserUid) {
        console.warn("[saveProgressToFirebase] No user logged in, cannot save progress to Firebase");
        return false;
    }

    try {
        const category = getSubjectKey();
        const progressRef = ref(db, `user-metadata/${window.currentUserUid}/gameProgress/${category}`);
        await set(progressRef, {
            ...progressData,
            mistakesCount: mistakesCount || [],
            lastUpdated: Date.now(),
            timestamp: new Date().toISOString()
        });
        console.log("[saveProgressToFirebase] Progress saved successfully to Firebase");
        return true;
    } catch (error) {
        console.error("[saveProgressToFirebase] Error saving progress to Firebase:", error);
        return false;
    }
}

/**
 * Helper to save all current session state to Firebase.
 */
async function saveCurrentProgress() {
    if (!window.currentUserUid) return;

    const savedCorrectList = JSON.parse(JSON.stringify(correctList));
    const savedWrongList = JSON.parse(JSON.stringify(wrongList));
    const progressData = {
        data, x, done,
        correctList: savedCorrectList,
        wrongList: savedWrongList,
        mistakesCount,
        unitStars,
        unitName: window.currentUnitName || undefined,
        jsonPath: window.currentJsonPath || undefined
    };
    return saveProgressToFirebase(progressData);
}

async function loadProgressFromFirebase() {
    if (!window.currentUserUid) {
        console.warn("[loadProgressFromFirebase] No user logged in, cannot load progress from Firebase");
        return null;
    }

    try {
        const category = getSubjectKey();
        const progressRef = ref(db, `user-metadata/${window.currentUserUid}/gameProgress/${category}`);
        const snapshot = await get(progressRef);

        if (snapshot.exists()) {
            const progressData = snapshot.val();
            console.log("[loadProgressFromFirebase] Progress loaded successfully from Firebase");
            return progressData;
        } else {
            console.log("[loadProgressFromFirebase] No progress found in Firebase");
            return null;
        }
    } catch (error) {
        console.error("[loadProgressFromFirebase] Error loading progress from Firebase:", error);
        return null;
    }
}

async function removeProgressFromFirebase() {
    if (!window.currentUserUid) {
        console.warn("[removeProgressFromFirebase] No user logged in, cannot remove progress from Firebase");
        return false;
    }

    try {
        const category = getSubjectKey();
        const progressRef = ref(db, `user-metadata/${window.currentUserUid}/gameProgress/${category}`);
        await set(progressRef, null);
        console.log("[removeProgressFromFirebase] Progress removed successfully from Firebase");
        return true;
    } catch (error) {
        console.error("[removeProgressFromFirebase] Error removing progress from Firebase:", error);
        return false;
    }
}

function getQuestionStatsPath(xIndex) {
    if (!data || xIndex === undefined || !data[xIndex]) return null;
    const subjectKey = getSubjectKey();
    const unitKey = toFirebaseSafeKey(window.currentJsonPath);
    const questionNum = data[xIndex].num || `q-${xIndex}`;
    return `question-stats/${subjectKey}/${unitKey}/${questionNum}`;
}

async function recordQuestionAttempt(isCorrect) {
    if (!window.currentUserUid) return; // Only logged in users contribute to stats
    const path = getQuestionStatsPath(x);
    if (!path) return;

    try {
        const statsRef = ref(db, path);
        await runTransaction(statsRef, (currentData) => {
            if (currentData === null) {
                return {
                    correctCount: isCorrect ? 1 : 0,
                    totalCount: 1
                };
            } else {
                return {
                    correctCount: (currentData.correctCount || 0) + (isCorrect ? 1 : 0),
                    totalCount: (currentData.totalCount || 0) + 1
                };
            }
        });
    } catch (error) {
        console.error("[recordQuestionAttempt] Error:", error);
    }
}

function updateAccuracyUI() {
    const accuracyDisplayEl = document.getElementById("accuracy-display");
    if (currentQuestionTotalCount > 0) {
        const percent = Math.round((currentQuestionCorrectCount / currentQuestionTotalCount) * 100);
        const percentText = `${percent}%`;
        currentQuestionAccuracyText = percentText;
        if (accuracyDisplayEl) {
            accuracyDisplayEl.textContent = percentText;
        }
        updateAnswerAccuracyBadge(percentText);
    } else {
        currentQuestionAccuracyText = "N/A";
        if (accuracyDisplayEl) accuracyDisplayEl.textContent = "N/A";
        updateAnswerAccuracyBadge("N/A");
    }
}

async function preloadStatsForIndex(qIndex) {
    const path = getQuestionStatsPath(qIndex);
    if (!path) return;
    if (statsCache.has(path)) return;

    statsCache.set(path, null);

    try {
        const statsRef = ref(db, path);
        const snapshot = await get(statsRef);
        if (snapshot.exists()) {
            const val = snapshot.val();
            statsCache.set(path, {
                correctCount: val.correctCount || 0,
                totalCount: val.totalCount || 0
            });
        } else {
            statsCache.set(path, {
                correctCount: 0,
                totalCount: 0
            });
        }
    } catch (e) {
        console.error(`[preloadStatsForIndex] Error preloading stats for index ${qIndex}:`, e);
        statsCache.delete(path);
    }
}

function preloadUpcomingStats() {
    if (!questionQueue.length) return;
    const count = Math.min(PRELOAD_AHEAD_COUNT, questionQueue.length);
    for (let i = 0; i < count; i++) {
        preloadStatsForIndex(questionQueue[i]);
    }
}

async function updateQuestionStatsAndProgress() {
    // 1. Update remaining progress
    try {
        const progressDisplayEl = document.getElementById("progress-display");
        if (progressDisplayEl && Array.isArray(done)) {
            const completed = done.filter(Boolean).length;
            const current = Math.min(completed + 1, done.length);
            progressDisplayEl.innerHTML = `
                <div style="display: inline-flex; align-items: center; justify-content: center; position: relative; font-family: 'Outfit', sans-serif;">
                    <span style="font-size: 1.25rem; font-weight: 800; color: var(--md-sys-color-primary); transform: translateY(-3px); line-height: 1;">${current}</span>
                    <span style="font-size: 1.25rem; font-weight: 300; opacity: 0.35; transform: rotate(16deg) scaleY(1.25) translateY(-1px); margin: 0; color: var(--text-secondary); line-height: 1;">/</span>
                    <span style="font-size: 0.9rem; font-weight: 600; opacity: 0.6; transform: translateY(4px); color: var(--text-secondary); line-height: 1;">${done.length}</span>
                </div>
            `;
        }
    } catch (e) {
        console.error("[updateQuestionStatsAndProgress] Error updating progress:", e);
    }

    // 2. Fetch and update statistical correct rate for the current question
    try {
        const path = getQuestionStatsPath(x);
        if (!path) {
            currentQuestionCorrectCount = 0;
            currentQuestionTotalCount = 0;
            updateAccuracyUI();
            return;
        }

        const cached = statsCache.get(path);
        if (cached) {
            currentQuestionCorrectCount = cached.correctCount || 0;
            currentQuestionTotalCount = cached.totalCount || 0;
            updateAccuracyUI();
            return;
        }

        const statsRef = ref(db, path);
        const snapshot = await get(statsRef);
        if (snapshot.exists()) {
            const val = snapshot.val();
            currentQuestionCorrectCount = val.correctCount || 0;
            currentQuestionTotalCount = val.totalCount || 0;
        } else {
            currentQuestionCorrectCount = 0;
            currentQuestionTotalCount = 0;
        }
        statsCache.set(path, {
            correctCount: currentQuestionCorrectCount,
            totalCount: currentQuestionTotalCount
        });
        updateAccuracyUI();
    } catch (e) {
        console.error("[updateQuestionStatsAndProgress] Error updating stats:", e);
        currentQuestionCorrectCount = 0;
        currentQuestionTotalCount = 0;
        updateAccuracyUI();
    }
}

function getAccuracyBadge(percentText) {
    if (!percentText || percentText === "N/A") return '';
    return `<span class="accuracy-badge" style="margin-left: 8px; padding: 2px 8px; background-color: var(--md-sys-color-primary-container, #e8f0fe); color: #808ca3; border-radius: 8px; font-size: 0.8rem; font-weight: 700; display: inline-flex; align-items: center; vertical-align: middle;">答對率 ${percentText}</span>`;
}

function updateAnswerAccuracyBadge(percentText) {
    const showAnsDiv = document.getElementById("showAnswer");
    if (!showAnsDiv) return;
    
    let badge = showAnsDiv.querySelector('.accuracy-badge');
    if (badge) {
        if (!percentText || percentText === "N/A") {
            badge.remove();
        } else {
            badge.textContent = `答對率 ${percentText}`;
        }
    } else {
        if (viewing && percentText && percentText !== "N/A") {
            const badgeHtml = getAccuracyBadge(percentText);
            const speakBtn = showAnsDiv.querySelector('.speak-answer-icon-button');
            if (speakBtn) {
                speakBtn.insertAdjacentHTML('beforebegin', badgeHtml);
            } else {
                showAnsDiv.insertAdjacentHTML('beforeend', badgeHtml);
            }
        }
    }
}
const signInBtn = document.getElementById('signInBtn');
function setAuthControlsEnabled(enabled) {
    const openDoc = document.getElementById('openDocBtn');
    if (openDoc) {
        // 不要禁用「題庫」按鈕，讓點擊可顯示「請先登入」提醒
        openDoc.removeAttribute('disabled');
    }
    const resume = document.getElementById('resumeButton');
    if (resume) resume.disabled = !enabled;
}
setAuthControlsEnabled(false);
if (signInBtn) {
    signInBtn.addEventListener('click', async () => {
        if (auth.currentUser) {
            try {
                await signOut(auth);
                showAlertModal('已成功登出');
            } catch (error) {
                console.error('登出失敗:', error);
                showAlertModal('登出失敗，請稍後再試');
            }
        } else {
            try {
                const result = await signInWithPopup(auth, provider);
                const user = result.user;
                if (!isAllowedEmail(user.email)) {
                    await signOut(auth);
                    showAlertModal('請使用醫學系 @g.ntu.edu.tw 帳號登入');
                    return;
                }
                showAlertModal('登入成功！');
                try { await fetchLeaderboard(); } catch (e) { console.error('[login] Failed to fetch leaderboard after Google login:', e); }
            } catch (error) {
                console.error('Google 登入失敗:', error);
                let msg = 'Google 登入失敗，請稍後再試。';
                if (error && error.code === 'auth/popup-closed-by-user') {
                    msg = '已關閉登入視窗。';
                }
                showAlertModal(msg);
            }
        }
    });
}
onAuthStateChanged(auth, user => {
    const btn = document.getElementById('signInBtn');
    const avatar = document.getElementById('user-avatar');
    const menuDisplayName = document.getElementById('menu-display-name');
    const menuEmail = document.getElementById('menu-email');

    if (user) {
        if (!isAllowedEmail(user.email)) {
            signOut(auth);
            showAlertModal('本系統僅限使用醫學系 @g.ntu.edu.tw 帳號');
            return;
        }
        window.currentUserUid = user.uid;
        const name = user.displayName || user.email;
        if (name) {
            window.currentPlayer = name;

            // Show Avatar, Hide Sign In
            if (btn) btn.style.display = 'none';
            if (avatar) {
                avatar.textContent = (user.displayName || user.email).charAt(0).toUpperCase();
                avatar.style.display = 'flex';
            }

            // Update Menu Info
            if (menuDisplayName) menuDisplayName.textContent = user.displayName || user.email.split('@')[0];
            if (menuEmail) menuEmail.textContent = user.email;

            setAuthControlsEnabled(true);

            // Hide separate buttons as they are now in the menu
            const starBtn = document.getElementById('openStarredTop');
            if (starBtn) starBtn.style.display = 'none';

            try { fetchLeaderboard(); } catch (e) { console.error('[auth] Failed to fetch leaderboard after login:', e); }
            updateStarButtonState();
        }
        setupTabs();
    } else {
        window.currentUserUid = null;
        window.currentPlayer = null;

        // Show Sign In, Hide Avatar
        if (btn) btn.style.display = 'flex';
        if (avatar) avatar.style.display = 'none';

        const profileMenu = document.getElementById('profile-menu');
        if (profileMenu) profileMenu.classList.remove('active');

        setAuthControlsEnabled(false);

        // Show separate buttons again if logged out
        const starBtn = document.getElementById('openStarredTop');
        if (starBtn) starBtn.style.display = 'none'; // Keep hidden on logout usually

        // starredCache = {}; // Removed global starredCache
        updateStarButtonState();
        fetchLeaderboard();
    }

window.mockLogin = function() {
    console.log("[mockLogin] Simulating mock login for local testing...");
    const user = {
        uid: "mock-user-12345",
        email: "test@g.ntu.edu.tw",
        displayName: "測試帳號"
    };
    window.currentUserUid = user.uid;
    window.currentPlayer = user.displayName;
    
    const btn = document.getElementById('signInBtn');
    const avatar = document.getElementById('user-avatar');
    const menuDisplayName = document.getElementById('menu-display-name');
    const menuEmail = document.getElementById('menu-email');

    if (btn) btn.style.display = 'none';
    if (avatar) {
        avatar.textContent = 'M';
        avatar.style.display = 'flex';
    }
    if (menuDisplayName) menuDisplayName.textContent = user.displayName;
    if (menuEmail) menuEmail.textContent = user.email;

    setAuthControlsEnabled(true);
    fetchLeaderboard();
    setupTabs();
};
    checkForExistingProgress().catch(error => {
        console.error("[onAuthStateChanged] Error checking for existing progress:", error);
    });
});

// Profile Menu Logic
document.addEventListener('DOMContentLoaded', () => {
    const avatar = document.getElementById('user-avatar');
    const menu = document.getElementById('profile-menu');

    if (avatar && menu) {
        avatar.addEventListener('click', (e) => {
            e.stopPropagation();
            menu.classList.toggle('active');
        });

        window.addEventListener('click', () => {
            menu.classList.remove('active');
        });

        menu.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        // Menu Actions






        document.getElementById('menu-edit-nickname').addEventListener('click', () => {
            const user = auth.currentUser;
            if (user && window.openNicknameModal) {
                const currentVal = user.displayName || user.email.split('@')[0];
                window.openNicknameModal(currentVal);
            }
            menu.classList.remove('active');
        });

        document.getElementById('menu-logout').addEventListener('click', async () => {
            try {
                await signOut(auth);
                showAlertModal('已成功登出');
            } catch (error) {
                console.error('Logout error:', error);
            }
            menu.classList.remove('active');
        });
    }
    if (typeof lucide !== 'undefined') lucide.createIcons();

    // Handle download link based on User Agent
    const userAgent = navigator.userAgent || navigator.vendor || window.opera;
    const link = document.querySelector('a[href="profile.mobileconfig"]');
    const downloadBlock = document.getElementById("download-block");

    if (link) {
        if (/android/i.test(userAgent)) {
            link.textContent = "安卓下載";
            link.setAttribute("href", "parasite_game_v1.apk");
            link.setAttribute("download", "Parasite.apk");
        } else if (/iPad|iPhone|iPod/.test(userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) {
            link.textContent = "蘋果下載";
            link.setAttribute("href", "profile.mobileconfig");
            link.setAttribute("download", "Parasite.mobileconfig");
        } else {
            if (downloadBlock) downloadBlock.style.display = "none";
        }
    }
});
window.currentPlayer = null;
var numOfProbs;
var data;
var x;
var tm;
var correct = 0;
var wrong = 0;
let sessionCorrect = 0;
let sessionWrong = 0;
var viewing = false;
var done;
var score = 0;
let initialLeaderboardEntries = [];
let lastUserRank = -1;
var correctList = [];
var wrongList = [];
let questionQueue = [];
const preloadedImagePaths = new Set();
const pendingPreloadMap = new Map();
const PRELOAD_AHEAD_COUNT = 3;
const lowerCaseSwearWords = [].map(word => word.toLowerCase());

const dayNightToggle = document.getElementById('dayNightToggle');
const dayNightIcon = document.getElementById('dayNightIcon');
let isDay = true;
window.gameplayActive = false;

function renderSun() {
    dayNightIcon.innerHTML = `
        <circle cx="50" cy="50" r="20" class="icon-shape" />
        <g class="sun-rays">
            ${[...Array(8)].map((_, i) => {
        const angle = (i * 45) * (Math.PI / 180);
        const x1 = 50 + Math.cos(angle) * 30;
        const y1 = 50 + Math.sin(angle) * 30;
        const x2 = 50 + Math.cos(angle) * 38;
        const y2 = 50 + Math.sin(angle) * 38;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="sun-ray" />`;
    }).join('')}
        </g>
        <g class="moon-group" style="opacity: 0;">
            <circle cx="50" cy="50" r="20" class="icon-shape" />
            <circle cx="58" cy="50" r="18" class="moon-mask" />
        </g>
    `;
    dayNightIcon.classList.remove('night');
    dayNightIcon.classList.add('day');
    dayNightIcon.classList.remove('rotate');
}


function renderMoon() {
    dayNightIcon.innerHTML = `
         <circle cx="50" cy="50" r="20" class="icon-shape" style="fill: none;"/>
         <g class="sun-rays" style="opacity: 0;">
             ${[...Array(8)].map((_, i) => {
        const angle = (i * 45) * (Math.PI / 180);
        const x1 = 50 + Math.cos(angle) * 30;
        const y1 = 50 + Math.sin(angle) * 30;
        const x2 = 50 + Math.cos(angle) * 38;
        const y2 = 50 + Math.sin(angle) * 38;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="sun-ray" />`;
    }).join('')}
         </g>
         <g class="moon-group">
             <circle cx="50" cy="50" r="20" class="icon-shape" />
             <circle cx="58" cy="50" r="18" class="moon-mask" />
         </g>
    `;
    dayNightIcon.classList.remove('day');
    dayNightIcon.classList.add('night');
    dayNightIcon.classList.add('rotate');
}

let availableVoices = [];
function populateVoices() {
    availableVoices = speechSynthesis.getVoices();
    if (speechSynthesis.onvoiceschanged !== undefined) {
        speechSynthesis.onvoiceschanged = () => {
            availableVoices = speechSynthesis.getVoices();
        };
    }
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

function resetPreloadState() {
    questionQueue = [];
    preloadedImagePaths.clear();
    pendingPreloadMap.clear();
}

function initializeQuestionQueue(keepOrder) {
    if (keepOrder === undefined) {
        keepOrder = (data && data.length > 0 && data[0].options !== undefined);
    }
    questionQueue = [];
    if (!Array.isArray(data) || !Array.isArray(done)) {
        return;
    }
    for (let i = 0; i < data.length; i++) {
        if (!done[i]) {
            questionQueue.push(i);
        }
    }
    if (!keepOrder && questionQueue.length > 1) {
        shuffleArray(questionQueue);
    }
    preloadUpcomingImages();
}

function preloadImageAtIndex(index) {
    if (!data || !data[index]) return;
    const item = data[index];

    const fullPath = resolveImagePath(item);

    if (!fullPath || preloadedImagePaths.has(fullPath) || pendingPreloadMap.has(fullPath)) return;

    const img = new Image();
    img.decoding = 'async';
    if ('loading' in HTMLImageElement.prototype) {
        img.loading = 'eager';
    }

    pendingPreloadMap.set(fullPath, img);
    img.onload = () => {
        preloadedImagePaths.add(fullPath);
        pendingPreloadMap.delete(fullPath);
        console.log(`[preload] Success: ${fullPath}`);
    };
    img.onerror = (error) => {
        pendingPreloadMap.delete(fullPath);
        console.warn(`[preload] Failed: ${fullPath}`, error);
    };
    img.src = fullPath;
}

function preloadUpcomingImages() {
    if (!questionQueue.length) return;
    const count = Math.min(PRELOAD_AHEAD_COUNT, questionQueue.length);
    for (let i = 0; i < count; i++) {
        preloadImageAtIndex(questionQueue[i]);
    }
    preloadUpcomingStats();
}

function addOrUpdateSpeakButton(answerToSpeak, answerDisplayElement) {
    let existingSpeakButton = answerDisplayElement.querySelector('.speak-answer-icon-button');
    if (existingSpeakButton) {
        existingSpeakButton.remove();
    }

    const speakButton = document.createElement('button');
    speakButton.className = 'speak-answer-icon-button';
    speakButton.setAttribute('aria-label', 'Play answer');
    speakButton.innerHTML = `
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="rgb(102, 102, 102)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle;">
            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
            <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path>
        </svg>
    `;
    speakButton.style.background = 'none';
    speakButton.style.border = 'none';
    speakButton.style.padding = '0 0 0 8px';
    speakButton.style.cursor = 'pointer';
    speakButton.style.display = 'inline-flex';
    speakButton.style.alignItems = 'center';
    speakButton.style.verticalAlign = 'middle';


    speakButton.onclick = (event) => {
        event.stopPropagation();
        if (speechSynthesis.speaking) {
            speechSynthesis.cancel();
        }
        const utterance = new SpeechSynthesisUtterance(answerToSpeak);
        let targetVoice = availableVoices.find(voice => voice.lang.startsWith('en') && (voice.name.toLowerCase().includes('google') || voice.name.toLowerCase().includes('natural')));
        if (!targetVoice) {
            targetVoice = availableVoices.find(voice => voice.lang.startsWith('en'));
        }
        if (targetVoice) {
            utterance.voice = targetVoice;
        }
        speechSynthesis.speak(utterance);
    };

    answerDisplayElement.appendChild(speakButton);
}


async function writeScore(finalScore, correctInc = 0, wrongInc = 0) {
    const uid = window.currentUserUid;
    if (!uid) {
        console.warn("[writeScore] No user logged in, score not recorded to leaderboard.");
        return { score, correct, wrong };
    }

    if (!window.currentPlayer || window.currentPlayer.trim() === "") {
        console.error("Player name is not set. Cannot write score to leaderboard.");
        showAlertModal("玩家名稱未設定，無法記錄分數。請重新開始並輸入名稱。");
        return { score, correct, wrong };
    }

    const scoreRef = ref(db, `ntumedsa-quiz/${uid}`);
    try {
        const snap = await get(scoreRef);
        const prev = snap.val();

        const prevScore = prev && typeof prev.score === 'number' ? prev.score : 0;
        const prevCorrect = prev && typeof prev.correct === 'number' ? prev.correct : 0;
        const prevWrong = prev && typeof prev.wrong === 'number' ? prev.wrong : 0;

        const newScore = prevScore + finalScore;
        const newCorrect = prevCorrect + correctInc;
        const newWrong = prevWrong + wrongInc;

        await update(scoreRef, {
            name: window.currentPlayer,
            score: newScore,
            correct: newCorrect,
            wrong: newWrong,
            timestamp: Date.now()
        });

        return { score: newScore, correct: newCorrect, wrong: newWrong };
    } catch (err) {
        console.error("寫入分數失敗：", err);
        throw err;
    }
}


async function fetchLeaderboard() {
    const listEl = document.getElementById("boardList");
    const mobileListEl = document.getElementById("mobileBoardList");
    if (listEl) listEl.innerHTML = '<li style="justify-content:center; opacity:0.6; border:none; padding:40px 0;">載入數據中...</li>';
    if (mobileListEl) mobileListEl.innerHTML = '<li style="justify-content:center; opacity:0.6; border:none; padding:40px 0;">載入數據中...</li>';

    try {
        const snap = await get(ref(db, 'ntumedsa-quiz'));
        const dataObj = snap.val() || {};
        const entries = Object.entries(dataObj).map(([uid, item]) => ({
            uid,
            ...item,
            score: (item && typeof item.score === 'number') ? item.score : 0
        }));
        initialLeaderboardEntries = [...entries]; // Store for local rank counting
        const sorted = entries.sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));

        if (listEl) listEl.innerHTML = '';
        if (mobileListEl) mobileListEl.innerHTML = '';

        if (sorted.length === 0) {
            const emptyMsg = '<li style="justify-content:center; opacity:0.6; border:none; padding:40px 0;">目前尚無排名數據</li>';
            if (listEl) listEl.innerHTML = emptyMsg;
            if (mobileListEl) mobileListEl.innerHTML = emptyMsg;
            return;
        }
        let inTop = false;
        let prevScore = null;
        let prevRank = 0;
        sorted.forEach((item, index) => {
            if (index < 35) {
                const li = document.createElement('li');
                if (item.uid === window.currentUserUid) li.classList.add('current-user');
                const rankSpan = document.createElement('span');
                rankSpan.className = 'leaderboard-rank';
                let rank;
                if (item.score === prevScore) {
                    rank = prevRank;
                } else {
                    rank = index + 1;
                    prevScore = item.score;
                    prevRank = rank;
                }
                rankSpan.textContent = rank;
                const nameSpan = document.createElement('span');
                nameSpan.className = 'leaderboard-name';
                nameSpan.textContent = item.name;
                const scoreSpan = document.createElement('span');
                scoreSpan.className = 'leaderboard-score';
                scoreSpan.textContent = item.score;
                li.append(rankSpan, nameSpan, scoreSpan);
                if (listEl) listEl.appendChild(li);
                if (mobileListEl) mobileListEl.appendChild(li.cloneNode(true));
                if (item.uid === window.currentUserUid) inTop = true;
            }
        });
        if (!inTop && window.currentUserUid) {
            const userIndex = sorted.findIndex(item => item.uid === window.currentUserUid);
            if (userIndex !== -1) {
                const item = sorted[userIndex];
                const li = document.createElement('li');
                li.classList.add('current-user');
                const rankSpan = document.createElement('span');
                rankSpan.className = 'leaderboard-rank';
                let userActualRank = 0;
                let scoreForPrevRank = null;
                let runningRankForUser = 0;
                for (let i = 0; i < sorted.length; i++) {
                    if (sorted[i].score !== scoreForPrevRank) {
                        runningRankForUser = i + 1;
                        scoreForPrevRank = sorted[i].score;
                    }
                    if (sorted[i].uid === window.currentUserUid) {
                        userActualRank = runningRankForUser;
                        break;
                    }
                }
                rankSpan.textContent = userActualRank || (sorted.filter(it => it.score > item.score).length + 1);
                const nameSpan = document.createElement('span');
                nameSpan.className = 'leaderboard-name';
                nameSpan.textContent = item.name;
                const scoreSpan = document.createElement('span');
                scoreSpan.className = 'leaderboard-score';
                scoreSpan.textContent = item.score;
                li.append(rankSpan, nameSpan, scoreSpan);
                if (listEl) listEl.appendChild(li);
                if (mobileListEl) mobileListEl.appendChild(li.cloneNode(true));
            }
        }
        const playerData = window.currentUserUid ? sorted.find(item => item.uid === window.currentUserUid) : null;
        const playerScore = playerData ? playerData.score : 0;
        const playerCorrect = (playerData && typeof playerData.correct === 'number') ? playerData.correct : 0;
        const playerWrong = (playerData && typeof playerData.wrong === 'number') ? playerData.wrong : 0;

        const scoreDisp = document.getElementById("score-display");
        if (scoreDisp) scoreDisp.textContent = playerScore;

        // 這裡永遠顯示當前會話的正確與錯誤，而非 Firebase 回傳的總計
        const correctDisp = document.getElementById("correct");
        if (correctDisp) correctDisp.innerText = sessionCorrect;

        const wrongDisp = document.getElementById("wrong");
        if (wrongDisp) wrongDisp.innerText = sessionWrong;

        score = playerScore;
        correct = playerCorrect;
        wrong = playerWrong;
        const rankDisplay = document.getElementById("rank-display");
        if (rankDisplay) {
            if (playerData) {
                const userDisplayRank = getDisplayRankFromSorted(sorted, window.currentUserUid);
                rankDisplay.textContent = userDisplayRank;
                lastUserRank = userDisplayRank;
            } else {
                rankDisplay.textContent = "N/A";
                lastUserRank = -1;
            }
        }
    } catch (err) {
        console.error("讀取排行榜失敗：", err);
        if (listEl) listEl.innerHTML = '<li>載入失敗</li>';
        if (mobileListEl) mobileListEl.innerHTML = '<li>載入失敗</li>';
        const rankDisplay = document.getElementById("rank-display");
        if (rankDisplay) rankDisplay.textContent = "N/A";
    }
}

// Helper function to calculate competition rank (handles ties)
function getDisplayRankFromSorted(sortedList, targetUid) {
    let currentOverallRank = 0;
    let scoreForLastOverallRank = null;
    for (let i = 0; i < sortedList.length; i++) {
        const entry = sortedList[i];
        const entryScore = (Number(entry.score) || 0);
        if (entryScore !== scoreForLastOverallRank) {
            currentOverallRank = i + 1;
            scoreForLastOverallRank = entryScore;
        }
        if (entry.uid === targetUid) {
            return currentOverallRank;
        }
    }
    return "N/A";
}

function updateRankLocally() {
    if (!initialLeaderboardEntries || initialLeaderboardEntries.length === 0) return;
    if (!window.currentUserUid) return;

    // Update or add current user in the local snapshot
    const userIndex = initialLeaderboardEntries.findIndex(e => e.uid === window.currentUserUid);
    const numScore = Number(score) || 0;
    if (userIndex !== -1) {
        initialLeaderboardEntries[userIndex].score = numScore;
    } else {
        initialLeaderboardEntries.push({ uid: window.currentUserUid, name: window.currentPlayer || "You", score: numScore });
    }

    // Calculate rank handling ties with numeric safety
    const sorted = [...initialLeaderboardEntries].sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0));
    const userDisplayRank = getDisplayRankFromSorted(sorted, window.currentUserUid);

    const rankDisplay = document.getElementById("rank-display");
    if (rankDisplay) {
        // If the user's rank status changed, apply animation and colors
        if (typeof userDisplayRank === 'number' && typeof lastUserRank === 'number') {
            if (userDisplayRank < lastUserRank) {
                // Rank Improved (Number decreased, e.g., 5 -> 3)
                rankDisplay.classList.remove('rank-up-text', 'rank-down-text');
                void rankDisplay.offsetWidth; // trigger reflow
                rankDisplay.classList.add('rank-up-text');
                setTimeout(() => rankDisplay.classList.remove('rank-up-text'), 1500);
            } else if (userDisplayRank > lastUserRank) {
                // Rank Dropped (Number increased, e.g., 3 -> 5)
                rankDisplay.classList.remove('rank-up-text', 'rank-down-text');
                void rankDisplay.offsetWidth; // trigger reflow
                rankDisplay.classList.add('rank-down-text');
                setTimeout(() => rankDisplay.classList.remove('rank-down-text'), 1500);
            }
        }

        // Set the text immediately after the 50% mark of animation (which happens via timeout if needed, but here simple setting)
        // Actually to make it look like a "tick", we update the text when it's invisible
        if (userDisplayRank !== lastUserRank) {
            setTimeout(() => {
                rankDisplay.textContent = userDisplayRank;
            }, 300); // sync with 50% point of 0.6s animation
        } else {
            rankDisplay.textContent = userDisplayRank;
        }
    }
    lastUserRank = userDisplayRank;
}

function updateCorrect() {
    sessionCorrect++;
    document.getElementById("correct").innerText = sessionCorrect;
    const pointsEarned = 2;

    if (data && data[x]) {
        correctList.push(data[x]);
        done[x] = true; // Mark as done when answered correctly
    }
    // Ensure array exists
    if (!mistakesCount) mistakesCount = new Array(data.length).fill(0);
    if (!unitStars) unitStars = new Array(data.length).fill(false);

    writeScore(pointsEarned, 1, 0)
        .then((result) => {
            if (result && typeof result.score === 'number') {
                score = result.score;
                correct = result.correct;
                wrong = result.wrong;
                updateRankLocally();
            }
            updateScoreDisplay();
            saveCurrentProgress(); // Save progress after answering
        })
        .catch(err => console.error("寫入分數或更新排名失敗：", err));

    // Update statistical correct rate locally & immediately
    currentQuestionTotalCount++;
    currentQuestionCorrectCount++;
    const path = getQuestionStatsPath(x);
    if (path) {
        statsCache.set(path, {
            correctCount: currentQuestionCorrectCount,
            totalCount: currentQuestionTotalCount
        });
    }
    updateQuestionStatsAndProgress();

    recordQuestionAttempt(true)
        .catch(err => console.error("更新 Firebase 答對率失敗：", err));
}
function updateWrong() {
    sessionWrong++;
    document.getElementById("wrong").innerText = sessionWrong;
    const pointsLost = -2;

    if (data && data[x]) {
        wrongList.push(data[x]);
        done[x] = true; // Mark as done when answered wrongly
        // Ensure array exists and is padded
        if (!mistakesCount) mistakesCount = new Array(data.length).fill(0);
        if (mistakesCount[x] === undefined) mistakesCount[x] = 0;
        mistakesCount[x]++;
    }
    if (!unitStars) unitStars = new Array(data.length).fill(false);

    writeScore(pointsLost, 0, 1)
        .then((result) => {
            if (result && typeof result.score === 'number') {
                score = result.score;
                correct = result.correct;
                wrong = result.wrong;
                updateRankLocally();
            }
            updateScoreDisplay();
            saveCurrentProgress(); // Save progress after answering
        })
        .catch(err => console.error("寫入分數或更新排名失敗：", err));

    saveUnitMistakesToFirebase(window.currentJsonPath);

    // Update statistical correct rate locally & immediately
    currentQuestionTotalCount++;
    const pathWrong = getQuestionStatsPath(x);
    if (pathWrong) {
        statsCache.set(pathWrong, {
            correctCount: currentQuestionCorrectCount,
            totalCount: currentQuestionTotalCount
        });
    }
    updateQuestionStatsAndProgress();

    recordQuestionAttempt(false)
        .catch(err => console.error("更新 Firebase 答對率失敗：", err));
}
function updateUnknown() {
    sessionWrong++;
    document.getElementById("wrong").innerText = sessionWrong;
    const pointsLost = -1;

    if (data && data[x]) {
        wrongList.push(data[x]);
        done[x] = true; // Mark as done when answer is revealed (Don't Know)
    }
    if (!unitStars) unitStars = new Array(data.length).fill(false);

    writeScore(pointsLost, 0, 1)
        .then((result) => {
            if (result && typeof result.score === 'number') {
                score = result.score;
                correct = result.correct;
                wrong = result.wrong;
                updateRankLocally();
            }
            updateScoreDisplay();
            saveCurrentProgress(); // Save progress after answering
        })
        .catch(err => console.error("寫入分數或更新排名失敗：", err));

    saveUnitMistakesToFirebase(window.currentJsonPath);

    updateQuestionStatsAndProgress()
        .catch(err => console.error("更新進度與答對率失敗：", err));
}

function handleEndOfRound() {
    const nextBtn = document.getElementById('next');
    const cardAnswerDiv = document.querySelector(".card-answer");

    cardAnswerDiv.style.display = "flex";
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';

    nextBtn.style.display = 'block';

    if (wrongList.length > 0) {
        nextBtn.innerText = "重玩錯誤";
        nextBtn.removeEventListener('click', nextProb);
        nextBtn.addEventListener('click', startReviewWrong);
        showAlertModal(`本回合錯誤 ${wrongList.length} 題。點擊「重玩錯誤」再次挑戰！`);
    } else {
        showAlertModal(`恭喜你全部答對！最終分數：${score} 🎉`);
        nextBtn.style.display = 'none';
        if (window.currentUserUid) { removeProgressFromFirebase().catch(e => console.warn('[endRound] Unable to clear Firebase progress:', e)); }
        window.gameplayActive = false;


        // 遊戲結束時一律清理全域事件聽取器
        document.removeEventListener("keydown", enterKeyEvent);
        const submitBtnEl = document.getElementById("submitAnswer");
        if (submitBtnEl) submitBtnEl.removeEventListener("click", submitUserAnswer);
        const dontKnowBtnEl = document.getElementById("dontKnow");
        if (dontKnowBtnEl) dontKnowBtnEl.removeEventListener("click", showAnswer);
        const correctAreaEl = document.getElementById("correctArea");
        if (correctAreaEl) correctAreaEl.removeEventListener("click", showCorrectList);
        const wrongAreaEl = document.getElementById("wrongArea");
        if (wrongAreaEl) wrongAreaEl.removeEventListener("click", showWrongList);
        if (nextBtn) nextBtn.removeEventListener('click', nextProb);

        // 清除之前的定時器以防重疊
        if (endRoundTimeout) clearTimeout(endRoundTimeout);

        endRoundTimeout = setTimeout(() => {
            // 在執行返回邏輯前確認使用者沒有開始新遊戲
            if (window.gameplayActive) return;

            const header = document.getElementById('mainHeader');
            if (header) header.style.display = 'flex';
            document.querySelector('.flashcard-container').style.display = 'none';
            document.querySelector('.start-screen').style.display = 'flex';
            const resumeButtonEl = document.getElementById('resumeButton');
            const progressActionsEl = document.querySelector('.progress-actions');
            const startButtonsEl = document.querySelector('.start-buttons');
            if (resumeButtonEl) resumeButtonEl.style.display = 'none';
            if (progressActionsEl) progressActionsEl.style.display = 'none';
            if (startButtonsEl) startButtonsEl.style.display = 'flex';
            document.title = "臺大醫跑臺機";
        }, 3000);
    }
}

window.handleEndOfRound = handleEndOfRound;

function startReviewWrong() {
    console.log("[startReviewWrong] Starting review of mistakes.");
    sessionCorrect = 0;
    sessionWrong = 0;
    document.getElementById("correct").innerText = "0";
    document.getElementById("wrong").innerText = "0";
    if (wrongList.length === 0) {
        console.warn("[startReviewWrong] No wrong answers to review.");
        handleEndOfRound();
        return;
    }

    data = [...wrongList];
    numOfProbs = data.length;

    wrongList = [];
    correctList = [];
    document.getElementById("correct").innerText = sessionCorrect;
    document.getElementById("wrong").innerText = sessionWrong;



    done = new Array(numOfProbs).fill(false);
    resetPreloadState();
    const isMultipleChoice = (data && data.length > 0 && data[0].options !== undefined);
    initializeQuestionQueue(isMultipleChoice);
    x = -1;

    const nextBtn = document.getElementById('next');
    nextBtn.innerText = "下題";
    nextBtn.removeEventListener('click', startReviewWrong);
    nextBtn.addEventListener('click', nextProb);

    document.querySelector('.card-answer').style.display = 'none';
    document.querySelector('.answer-input-container').style.visibility = 'visible';
    document.querySelector('.bottom-buttons').style.visibility = 'visible';

    viewing = false;

    nextProb();
}



function init() {
    console.log("[init] Initializing application.");
    populateVoices();



    fetchLeaderboard();
    const leaderboardEl = document.querySelector('.leaderboard');









    document.addEventListener("keydown", function (e) {
        if (isComposing) return;

        if (e.key === "/" || e.key === "Enter") {
            const answerInput = document.getElementById("answer");
            const playerNameInput = document.getElementById("signInBtn");
            const explanationContribInput = document.getElementById('explanation-input');
            const commentInput = document.getElementById('commentInput');

            // If typing in comment box, let the comment box handle it
            if (commentInput && document.activeElement === commentInput) return;

            const flashcardContainer = document.querySelector('.flashcard-container');
            const isGameActive = flashcardContainer && getComputedStyle(flashcardContainer).display !== 'none';

            let focused = false;
            if (isGameActive) {
                if (answerInput && document.activeElement !== answerInput &&
                    (!explanationContribInput || document.activeElement !== explanationContribInput)) {
                    answerInput.focus();
                    focused = true;
                }
            } else {
                const startScreen = document.querySelector('.start-screen');
                const isStartScreenActive = startScreen && getComputedStyle(startScreen).display !== 'none';
                if (isStartScreenActive && playerNameInput && document.activeElement !== playerNameInput) {
                    playerNameInput.focus();
                    focused = true;
                }
            }

            if (focused) {
                e.preventDefault();
            }
        }
    });







    document.getElementById('modalStartQuizBtn').addEventListener('click', () => {
        if (currentUnitUrl) {
            document.getElementById('unitSelectionModal').style.display = 'none';
            createStartHandler(currentUnitUrl, currentSelectedUnitName)();
        }
    });

    document.getElementById('modalOpenDocBtn').addEventListener('click', () => {
        if (currentUnitUrl) {
            document.getElementById('unitSelectionModal').style.display = 'none';
            window.openTikuHandler(currentUnitUrl)();
        }
    });

    document.getElementById('closeUnitModal').addEventListener('click', () => {
        document.getElementById('unitSelectionModal').style.display = 'none';
    });

    window.addEventListener('click', (e) => {
        const modal = document.getElementById('unitSelectionModal');
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    setupTabs();

    // Mobile leaderboard toggle
    const boardToggle = document.getElementById('leaderboardToggle');
    const boardEl = document.querySelector('.leaderboard');
    if (boardToggle && boardEl) {
        boardToggle.onclick = () => {
            // Only toggle on mobile (width < 1024)
            if (window.innerWidth < 1024) {
                boardEl.classList.toggle('is-expanded');
            }
        };
    }



    adjustPlaceholder();
    window.addEventListener('resize', adjustPlaceholder);

    // Scroll hide header for Unit Review
    const docPage = document.querySelector('.doc-page');
    const docHeader = document.querySelector('.doc-header');
    let lastScrollTop = 0;
    if (docPage && docHeader) {
        docPage.addEventListener('scroll', () => {
            let st = docPage.scrollTop;
            // Standard: Hide on scroll down, show on scroll up
            // But user asked: "hidden after i scroll up"
            // If they meant "scroll up" = finger up (scrolling down), then:
            if (st > lastScrollTop && st > 50) {
                docHeader.classList.add('header-hidden');
            } else {
                docHeader.classList.remove('header-hidden');
            }
            lastScrollTop = st <= 0 ? 0 : st;
        }, { passive: true });
    }
}

async function loadSpecificJsonData(jsonPath) {
    if (jsonPath.startsWith('all:')) {
        const baseUrl = jsonPath.split(':')[1];
        return await loadAllSubjectData(baseUrl);
    }
    if (jsonPath === 'all') {
        return await loadAllJsonData();
    }
    try {
        const response = await $.getJSON(jsonPath);
        let baseUrl = '.';
        if (jsonPath.includes('/JSON/')) {
            baseUrl = jsonPath.split('/JSON/')[0];
        }
        return Array.isArray(response) ? response.map(item => ({ ...item, baseUrl })) : [];
    } catch (error) {
        console.warn(`[loadSpecificJsonData] Failed to load ${jsonPath}:`, error);
        return [];
    }
}

window.openTikuHandler = function (jsonPath) {
    return async function () {
        if (jsonPath.startsWith('all:')) {
            window.currentBaseUrl = '.' + jsonPath.split(':')[1];
        } else if (jsonPath.includes('/JSON/')) {
            window.currentBaseUrl = jsonPath.split('/JSON/')[0];
        } else {
            window.currentBaseUrl = '.';
        }
        if (!auth.currentUser) {
            showAlertModal('請先登入');
            return;
        }

        const userEmail = auth.currentUser.email || '';
        if (!isAllowedEmail(userEmail)) {
            showAlertModal('請使用醫學系 @g.ntu.edu.tw 帳號登入以使用本系統');
            return;
        }

        const container = document.getElementById("docContainer");
        const content = document.getElementById("docContent");
        container.style.display = 'flex';
        content.innerHTML = '<p class="text-center py-12 text-gray-500 font-medium">載入中...</p>';

        try {
            const dataArr = await loadSpecificJsonData(jsonPath);
            window.docData = dataArr;
            content.innerHTML = '';

            const docCountEl = document.getElementById('docCount');
            if (docCountEl) docCountEl.textContent = `共 ${dataArr.length} 題`;

            const category = getSubjectKey(jsonPath);
            let progStats = null;
            if (window.currentUserUid) {
                const progressRef = ref(db, `user-metadata/${window.currentUserUid}/gameProgress/${category}`);
                const snapshot = await get(progressRef);
                if (snapshot.exists()) progStats = snapshot.val();
            }

            // Sorting: Starred first (true > false), then MistakesCount (descending)
            dataArr.sort((a, b) => {
                let aMistakes = 0, aStarred = false;
                let bMistakes = 0, bStarred = false;
                if (progStats && progStats.data) {
                    const aIdx = progStats.data.findIndex(p => (p.num && p.num === a.num) || (p.path && p.path === a.path));
                    if (aIdx !== -1) {
                        aMistakes = (progStats.mistakesCount && progStats.mistakesCount[aIdx]) || 0;
                        aStarred = (progStats.unitStars && progStats.unitStars[aIdx]) || false;
                    }
                    const bIdx = progStats.data.findIndex(p => (p.num && p.num === b.num) || (p.path && p.path === b.path));
                    if (bIdx !== -1) {
                        bMistakes = (progStats.mistakesCount && progStats.mistakesCount[bIdx]) || 0;
                        bStarred = (progStats.unitStars && progStats.unitStars[bIdx]) || false;
                    }
                }
                if (aStarred !== bStarred) return aStarred ? -1 : 1;
                return bMistakes - aMistakes;
            });

            dataArr.forEach((item, index) => {
                const entry = document.createElement('div');
                entry.className = 'doc-entry';

                // Check stats from progress
                let itemMistakes = 0;
                let itemIsStarred = false;

                if (progStats) {
                    // Try to find the item in progStats.data by matching num or path
                    // Or if the order is exactly the same (usually is for Tiku)
                    const matchedIdx = progStats.data.findIndex(pItem =>
                        (pItem.num && pItem.num === item.num) || (pItem.path && pItem.path === item.path)
                    );
                    if (matchedIdx !== -1) {
                        itemMistakes = (progStats.mistakesCount && progStats.mistakesCount[matchedIdx]) || 0;
                        itemIsStarred = (progStats.unitStars && progStats.unitStars[matchedIdx]) || false;
                    }
                }

                if (item.path) {
                    const imgContainer = document.createElement('div');
                    imgContainer.className = 'doc-img-container';
                    imgContainer.style.position = 'relative';

                    const img = document.createElement('img');
                    // ... picref logic ...
                    let picref = item.path;
                    if (picref && !picref.startsWith('http')) {
                        let itemBaseUrl = item.baseUrl || window.currentBaseUrl || '.';
                        if (!picref.startsWith(itemBaseUrl)) {
                            let cleanBase = itemBaseUrl.endsWith('/') ? itemBaseUrl.slice(0, -1) : itemBaseUrl;
                            picref = `${cleanBase}/images/${picref}`;
                        }
                    }
                    img.src = picref;
                    img.alt = item.answer && item.answer[0] ? item.answer[0] : '';
                    img.style.cursor = 'default';

                    const relativeWrapper = document.createElement('div');
                    relativeWrapper.style.position = 'relative';
                    relativeWrapper.style.display = 'inline-block';
                    relativeWrapper.appendChild(img);

                    imgContainer.appendChild(relativeWrapper);
                    entry.appendChild(imgContainer);
                }
                const textWrapper = document.createElement('div');
                textWrapper.className = 'doc-text';

                // Stats Header
                // Stats Header Container
                const statsContainer = document.createElement('div');
                statsContainer.className = 'flex items-center gap-2 mb-4';

                // 1. Error Count Capsule
                const statsLine = document.createElement('div');
                statsLine.className = 'doc-stats-line';
                statsLine.style.marginBottom = '0';
                statsLine.innerHTML = `
                    <div class="doc-stats-item">
                        <i data-lucide="x-circle" style="width:14px;height:14px;"></i>
                        <span>錯誤: ${itemMistakes}</span>
                    </div>
                `;
                statsContainer.appendChild(statsLine);

                // 2. Starred Status Capsule
                if (itemIsStarred) {
                    const starredItem = document.createElement('div');
                    starredItem.className = 'doc-stats-item starred';
                    starredItem.style.padding = '6px 12px';
                    starredItem.style.fontSize = '0.85rem';
                    starredItem.style.fontWeight = '500';
                    starredItem.innerHTML = `
                        <i data-lucide="star" style="width:14px;height:14px;fill:currentColor;"></i>
                        <span class="ml-1">已標星號</span>
                    `;
                    statsContainer.appendChild(starredItem);
                }
                textWrapper.appendChild(statsContainer);

                if (item.description) {
                    const desc = document.createElement('p');
                    desc.className = 'text-gray-600 italic mb-2';
                    desc.innerHTML = `<em>${escapeHtml(item.description)}</em>`;
                    textWrapper.appendChild(desc);
                }
                const ans = document.createElement('p');
                const answerContent = Array.isArray(item.answer) ? item.answer.join(' / ') : '';
                ans.className = 'text-lg font-bold text-[var(--md-sys-color-on-surface)] mb-4';
                ans.innerHTML = `${escapeHtml(answerContent)}`;
                textWrapper.appendChild(ans);

                if (item.explanation || (item.num !== undefined && item.num !== null)) {
                    const details = document.createElement('details');
                    details.className = 'doc-explanation mt-4 group';

                    const summary = document.createElement('summary');
                    summary.className = 'flex items-center gap-2 cursor-pointer text-sm font-medium text-[var(--accent-blue)] hover:opacity-80 transition-opacity list-none';
                    summary.innerHTML = `
                        <i data-lucide="chevron-down" class="w-4 h-4 transition-transform group-open:rotate-180"></i>
                        查看詳解
                    `;

                    details.appendChild(summary);

                    if (item.explanation) {
                        const pre = document.createElement('pre');
                        pre.className = 'mt-3 p-4 rounded-xl bg-gray-50 border border-gray-100 text-sm leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap font-sans';
                        pre.textContent = item.explanation;
                        details.appendChild(pre);
                    }

                    if (item.num !== undefined && item.num !== null && String(item.num).trim() !== '') {
                        const errata = document.createElement('p');
                        errata.className = 'errata-number';
                        errata.textContent = `題號: ${item.num}`;
                        details.appendChild(errata);
                    }

                    textWrapper.appendChild(details);
                }
                entry.appendChild(textWrapper);

                // Re-initialize lucide icons for the new elements
                if (window.lucide) {
                    window.lucide.createIcons({
                        attrs: {
                            class: 'lucide-icon'
                        }
                    });
                }
                content.appendChild(entry);
                if (typeof lucide !== 'undefined') lucide.createIcons();
            });
        } catch (err) {
            console.error('[openTikuHandler] Failed to load data for doc view:', err);
            content.innerHTML = '<p>讀取資料失敗</p>';
        }
    };
};





const resumeBtn = document.getElementById('resumeButton');
const restartProgress = document.getElementById('restartProgress');
if (resumeBtn) {
    resumeBtn.addEventListener('click', async () => {
        console.log("[resumeButton] Clicked. Attempting to resume progress.");

        if (!auth.currentUser) {
            showAlertModal("請先登入才能接續遊戲！");
            return;
        }
        if (endRoundTimeout) clearTimeout(endRoundTimeout);
        window.currentPlayer = (auth.currentUser.displayName || auth.currentUser.email || "使用者");

        window.gameplayActive = true;
        console.log("[resumeButton] Set window.gameplayActive to true");

        const header = document.getElementById("mainHeader"); if (header) header.style.display = "none";

        document.querySelector('.start-screen').style.display = 'none';
        console.log("[resumeButton] Set start-screen display to 'none'.");
        document.querySelector('.progress-actions').style.display = 'block';
        const startBtns = document.querySelector('.start-buttons');
        if (startBtns) startBtns.style.display = 'none';

        // Load progress from Firebase (Firebase only)
        let prog = null;

        if (window.currentUserUid) {
            try {
                prog = await loadProgressFromFirebase();
                if (prog) {
                    console.log("[resumeButton] Loaded progress from Firebase:", JSON.parse(JSON.stringify(prog)));
                }
            } catch (error) {
                console.error("[resumeButton] Error loading progress from Firebase:", error);
            }
        }

        if (!prog) {
            console.warn("[resumeButton] No progress found in Firebase.");
            window.gameplayActive = false;
            document.getElementById('resumeButton').style.display = 'none';
            document.querySelector('.progress-actions').style.display = 'none';
            document.querySelector('.start-screen').style.display = '';
            return;
        }

        // Validate progress data
        if (!prog || typeof prog !== 'object') {
            console.error("[resumeButton] Invalid progress data format");
            showAlertModal('進度讀取失敗，已清除損壞的進度，請重新開始。');
            window.gameplayActive = false;
            document.getElementById('resumeButton').style.display = 'none';
            document.querySelector('.progress-actions').style.display = 'none';
            document.querySelector('.flashcard-container').style.display = 'none';
            document.querySelector('.start-screen').style.display = '';

            // Clear Firebase
            if (window.currentUserUid) {
                removeProgressFromFirebase();
            }
            return;
        }

        let resumedData = prog.data;
        if (resumedData && typeof resumedData === 'object' && !Array.isArray(resumedData)) {
            const arr = [];
            const keys = Object.keys(resumedData).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
            keys.forEach(k => {
                arr.push(resumedData[k]);
            });
            resumedData = arr;
        }
        data = Array.isArray(resumedData) ? resumedData : [];
        console.log("[resumeButton] Loaded data from progress. Length:", data.length);
        if (data.length === 0) {
            console.error("Resumed data is empty. Clearing progress.");
            // Clear Firebase
            if (window.currentUserUid) {
                removeProgressFromFirebase();
            }
            window.gameplayActive = false;
            document.getElementById('resumeButton').style.display = 'none';
            document.querySelector('.progress-actions').style.display = 'none';
            const startBtns = document.querySelector('.start-buttons');
            if (startBtns) startBtns.style.display = 'flex';
            document.querySelector('.flashcard-container').style.display = 'none';
            document.querySelector('.start-screen').style.display = '';
            showAlertModal('進度讀取錯誤（無題目資料），已清除舊進度，請重新開始。');
            return;
        }
        numOfProbs = data.length;

        x = Number(prog.x) || 0;
        if (x < 0 || x >= numOfProbs) {
            console.warn(`[resumeButton] Resumed question index ${prog.x} is out of bounds for ${numOfProbs} questions. Resetting to 0.`);
            x = 0;
        }
        console.log("[resumeButton] Current question index x:", x);

        done = (Array.isArray(prog.done) && prog.done.length === numOfProbs) ? prog.done : new Array(numOfProbs).fill(false);
        console.log("[resumeButton] Loaded 'done' array:", JSON.parse(JSON.stringify(done)));

        // restore unit info if available
        if (prog.unitName) { window.currentUnitName = prog.unitName; }
        if (prog.jsonPath) { window.currentJsonPath = prog.jsonPath; }

        // Update Tab Title
        document.title = `${window.currentUnitName || '單元'} ｜ 臺大醫跑臺機`;

        // update resume label and progress in case UI is visible
        try {
            const unitNameText = (prog.unitName || window.currentUnitName || '單元');
            const total = Array.isArray(prog.data) ? prog.data.length : 0;
            const completed = Array.isArray(prog.done) ? prog.done.filter(Boolean).length : 0;
            const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
            const resumeEl = document.getElementById('resumeButton');
            if (resumeEl) resumeEl.textContent = `繼續 ${unitNameText}`;
            const resumeProgress = document.getElementById('resumeProgress');
            const fill = document.getElementById('resumeProgressFill');
            const text = document.getElementById('resumeProgressText');
            if (resumeProgress && fill && text) {
                resumeProgress.style.display = 'flex';
                fill.style.width = `${percent}%`;
                text.textContent = `${percent}%`;
            }
        } catch (e) { }

        const isMultipleChoice = (data && data.length > 0 && data[0].options !== undefined);
        resetPreloadState();
        initializeQuestionQueue(isMultipleChoice);

        // Do not overwrite global all-time stats with unit-specific session stats


        correctList = Array.isArray(prog.correctList) ? prog.correctList : [];
        wrongList = Array.isArray(prog.wrongList) ? prog.wrongList : [];
        const storedMistakes = await loadUnitMistakesFromFirebase(numOfProbs, prog.jsonPath || window.currentJsonPath);
        const progressMistakes = Array.isArray(prog.mistakesCount) ? prog.mistakesCount : new Array(numOfProbs).fill(0);
        mistakesCount = mergeMistakesCounts(storedMistakes, progressMistakes, numOfProbs);
        saveUnitMistakesToFirebase(prog.jsonPath || window.currentJsonPath);
        unitStars = await loadUnitStarsFromFirebase(numOfProbs, prog.jsonPath || window.currentJsonPath);
        updateStarButtonState();
        console.log("[resumeButton] Loaded scores and lists. Correct:", correct, "Wrong:", wrong);
        console.log("[resumeButton] correctList:", JSON.parse(JSON.stringify(correctList)));
        console.log("[resumeButton] wrongList:", JSON.parse(JSON.stringify(wrongList)));

        sessionCorrect = correctList.length;
        sessionWrong = wrongList.length;

        updateScoreDisplay();
        fetchLeaderboard().catch(err => console.error("[resumeButton] Failed to fetch leaderboard on resume:", err));

        if (isMultipleChoice) {
            resumeMultipleChoiceQuiz(prog.data, prog.jsonPath, prog.unitName, prog);
        } else {
            document.querySelector('.flashcard-container').style.display = 'flex';
            document.getElementById('closeModal').addEventListener('click', function () {
                document.getElementById('modal').style.display = "none";
            });
            resumeFlashcardQuiz(prog.data, prog.jsonPath, prog.unitName, prog);
        }
        window.preloadNextImage();
        console.log("[resumeButton] Resume process finished.");
    });
}
if (restartProgress) {
    restartProgress.addEventListener('click', async () => {
        console.log("[restartProgress] Clicked. Clearing game progress from Firebase.");
        if (endRoundTimeout) clearTimeout(endRoundTimeout);
        window.gameplayActive = false;
        console.log("[restartProgress] Set window.gameplayActive to false");

        // Clear progress from Firebase only
        if (window.currentUserUid) {
            const success = await removeProgressFromFirebase();
            if (success) {
                console.log("[restartProgress] Successfully cleared progress from Firebase");
            } else {
                console.warn("[restartProgress] Failed to clear progress from Firebase, but continuing...");
            }
        }
        showAlertModal('進度已清除');
        const header = document.getElementById("mainHeader"); if (header) header.style.display = "flex";


        document.querySelector('.flashcard-container').style.display = 'none';
        document.querySelector('.start-screen').style.display = 'flex';

        document.getElementById('resumeButton').style.display = 'none';
        document.querySelector('.progress-actions').style.display = 'none';
        document.querySelector('.start-buttons').style.display = 'flex';

        console.log("[restartProgress] Clearing unit-specific progress before restart.");
        sessionCorrect = 0;
        sessionWrong = 0;
        correctList = [];
        wrongList = [];

        done = [];
        x = -1;
        resetPreloadState();



        console.log("[restartProgress] Cleared correctList:", JSON.parse(JSON.stringify(correctList)), "wrongList:", JSON.parse(JSON.stringify(wrongList)));

        document.getElementById("correct").innerText = sessionCorrect;
        document.getElementById("wrong").innerText = sessionWrong;
        updateScoreDisplay();

        const imageElement = document.getElementById("image");
        if (imageElement) {
            imageElement.src = "";
            imageElement.alt = "Parasite Image";
            imageElement.classList.remove('loaded');
        }
        const loadingScreen = document.querySelector('.loading-screen');
        if (loadingScreen) {
            loadingScreen.style.display = 'none';
        }
        const answerInput = document.getElementById("answer");
        if (answerInput) {
            answerInput.value = "";
        }
        const showAnswerDiv = document.getElementById("showAnswer");
        if (showAnswerDiv) {
            showAnswerDiv.innerHTML = "";
        }
        const showExplanationDiv = document.getElementById("showExplanation");
        if (showExplanationDiv) {
            showExplanationDiv.innerHTML = "";
            showExplanationDiv.style.display = "none";
        }
        const cardAnswerOverlay = document.querySelector(".card-answer");
        if (cardAnswerOverlay) {
            cardAnswerOverlay.style.display = "none";
        }
        adjustPlaceholder();
        console.log("[restartProgress] UI reset complete.");
    });
}


function sendToGoogleDocs(content) {
    const url = 'https://script.google.com/macros/s/AKfycbzWbgs69CkM1nsQKCdtSp26b0LKmCqpzqlAnuetqzgqfd3KVkcZSjWB19vmNhcvlXeO/exec';
    const submitButton = document.getElementById('submit-explanation-button');

    fetch(url, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', },
        body: new URLSearchParams({ content: content })
    })
        .then(() => { console.log("Data likely sent successfully (no-cors mode)."); })
        .catch(error => {
            console.error('Error sending data:', error);
            showAlertModal('送出詳解時發生錯誤，請稍後再試。');
            if (submitButton) {
                submitButton.disabled = false;
                submitButton.classList.remove('loading');
            }
            return;
        })
    setTimeout(hideContributionInput, 300);
}

function parseMultiAns(data) {
    if (!data) return [];
    Object.values(data).forEach(item => {
        if (item && typeof item.answer === 'string') {
            item.answer = item.answer.split(" / ").map(s => s.trim()).filter(s => s);
        } else if (!item || typeof item.answer === 'undefined') {
            item.answer = [];
        }
    });
    return data;
}
function enterKeyEvent(event) {
    if (isComposing) return;
    if (event.key === 'Enter') {
        const commentInput = document.getElementById('commentInput');
        if (commentInput && document.activeElement === commentInput) return;

        const explanationInput = document.getElementById('explanation-input');
        if (explanationInput && document.activeElement === explanationInput && explanationInput.offsetParent !== null) {
            event.preventDefault();
            submitContribution();
        } else if (!viewing && document.getElementById("answer").value.trim() !== "") {
            submitUserAnswer();
        } else if (viewing && document.querySelector('.card-answer').style.display === 'flex') {
            const nextBtn = document.getElementById('next');
            if (nextBtn && nextBtn.style.display !== 'none') {
                nextBtn.click();
            }
        }
    }
}
function startGame() {
    console.log("[startGame] Called. Setting up game event listeners.");

    // 先清理舊的聽取器以防重複呼叫導致的跳題問題
    document.removeEventListener("keydown", enterKeyEvent);
    document.getElementById("submitAnswer").removeEventListener("click", submitUserAnswer);
    document.getElementById("dontKnow").removeEventListener("click", showAnswer);
    document.getElementById("correctArea").removeEventListener("click", showCorrectList);
    document.getElementById("wrongArea").removeEventListener("click", showWrongList);

    document.addEventListener("keydown", enterKeyEvent);
    document.getElementById("submitAnswer").addEventListener("click", submitUserAnswer);
    document.getElementById("dontKnow").addEventListener("click", showAnswer);
    document.getElementById("correctArea").addEventListener("click", showCorrectList);
    document.getElementById("wrongArea").addEventListener("click", showWrongList);
    document.getElementById('closeModal').addEventListener('click', function () {
        document.getElementById('modal').style.display = "none";
    });

    window.addEventListener('click', function (event) {
        let regularModal = document.getElementById('modal');
        if (event.target === regularModal) {
            regularModal.style.display = "none";
        }
    });

    nextProb();
    try { updateStarButtonState(); } catch (e) { }
    console.log("[startGame] Finished. Called nextProb().");
}
function checkAns(input, ansArr) {
    if (!Array.isArray(ansArr)) return false;
    const normalize = (str) => {
        if (typeof str !== 'string') return "";
        const substituted = str.toLowerCase()
            .replace(/\bmuscles?\b/g, "m")
            .replace(/\bnerves?\b/g, "n")
            .replace(/\barter(ies|y)\b/g, "a")
            .replace(/\bveins?\b/g, "v")
            .replace(/\bligaments?\b/g, "lig")
            .replace(/\bof\b/g, "")
            .replace(/\bto\b/g, "");
        const noPunctuation = substituted.replace(/[\p{P}]/gu, " ");
        const words = noPunctuation.trim().split(/\s+/);
        const normalizedWords = words
            .map(w => w.replace(/s/g, ""))
            .filter(w => w.length > 0);
        return normalizedWords.sort().join("");
    };
    
    let expandedAnsArr = [];
    ansArr.forEach(ans => {
        if (typeof ans !== 'string') return;
        let variants = [ans];
        
        // 1. Handle "or" options like "A (or B)"
        const orRegex = /(\w+)\s*\((?:or|OR)\s+([^)]+)\)/g;
        let orMatch;
        while ((orMatch = orRegex.exec(ans)) !== null) {
            const fullMatch = orMatch[0];
            const wordA = orMatch[1];
            const wordB = orMatch[2].trim();
            let nextVariants = [];
            variants.forEach(v => {
                nextVariants.push(v.replace(fullMatch, wordA));
                nextVariants.push(v.replace(fullMatch, wordB));
            });
            variants = nextVariants;
        }
        
        // 2. Handle optional parentheses like "(anterior limb)"
        let finalVariants = [];
        variants.forEach(v => {
            let current = [v];
            const localRegex = /\(([^)]+)\)/g;
            let m;
            while ((m = localRegex.exec(v)) !== null) {
                const fullMatch = m[0];
                const innerText = m[1].trim();
                
                // Skip labels
                if (/^\d+$/.test(innerText) || innerText.length <= 1) {
                    continue;
                }
                
                let next = [];
                current.forEach(c => {
                    next.push(c.replace(fullMatch, innerText));
                    next.push(c.replace(fullMatch, "").replace(/\s+/g, " "));
                });
                current = next;
            }
            finalVariants = finalVariants.concat(current);
        });
        
        expandedAnsArr = expandedAnsArr.concat(finalVariants);
    });
    
    const uniqueExpandedAnsArr = [...new Set(expandedAnsArr)];
    const normalizedInput = normalize(input);
    return uniqueExpandedAnsArr.some(ans => normalize(ans) === normalizedInput);
}
function submitUserAnswer() {
    console.log("[submitUserAnswer] Called. viewing:", viewing, "isComposing:", isComposing);
    if (isComposing) {
        console.log("[submitUserAnswer] Bailed: isComposing is true.");
        return;
    }
    var userAnswerRaw = document.getElementById("answer").value;
    var lowerUserAnswer = userAnswerRaw.replace(/[\p{P}\s]/gu, "").toLowerCase();
    console.log("[submitUserAnswer] User answer (raw):", userAnswerRaw, "(lower):", lowerUserAnswer);


    /*if (lowerUserAnswer && lowerCaseSwearWords.some(swearWord => lowerUserAnswer.includes(swearWord))) {
        window.open('https://youtu.be/HmIMmFAV4BY', '_blank');
        document.getElementById("answer").value = "";
        console.log("[submitUserAnswer] Swear word detected. Bailing.");
        return;
    }*/ //Prevent swear word identification

    if (viewing) {
        console.log("[submitUserAnswer] Bailed: viewing is true.");
        return;
    }
    clearTimeout(tm);

    var userAnswer = userAnswerRaw;
    if (userAnswer.replace(/[\p{P}\s]/gu, "") === "") return;

    viewing = true;
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';


    var showAnsDiv = document.getElementById("showAnswer");
    var cardAnswerDiv = document.querySelector(".card-answer");
    cardAnswerDiv.style.display = "flex";

    if (checkAns(userAnswer, data[x].answer)) {
        showAnsDiv.innerHTML = data[x].answer.map(ans => {
            if (checkAns(userAnswer, [ans])) {
                return `<span style="color: var(--accent-green);">${ans}</span>`;
            }
            return ans;
        }).join(' / ') + getAccuracyBadge(currentQuestionAccuracyText);
        if (data[x].answer && data[x].answer.length > 0) {
            const primaryAnswerToSpeak = data[x].answer[0];
            if (primaryAnswerToSpeak) {
                addOrUpdateSpeakButton(primaryAnswerToSpeak, showAnsDiv);
            }
        }
        updateCorrect();
        showExplanation();
    } else {
        showAnsDiv.innerHTML = `<span style="color: var(--accent-red);">${userAnswer}</span> <span style="opacity: 0.3; margin: 0 8px;">|</span> ${data[x].answer.join(' / ')}` + getAccuracyBadge(currentQuestionAccuracyText);
        if (data[x].answer && data[x].answer.length > 0) {
            const primaryAnswerToSpeak = data[x].answer[0];
            if (primaryAnswerToSpeak) {
                addOrUpdateSpeakButton(primaryAnswerToSpeak, showAnsDiv);
            }
        }
        updateWrong();
        showExplanation();
    }


}

function showAnswer() {
    console.log("[showAnswer] Called (Don't Know). viewing:", viewing);
    if (viewing) {
        console.log("[showAnswer] Bailed: viewing is true.");
        return;
    }
    clearTimeout(tm);
    console.log("[showAnswer] Current question item (data[x]):", JSON.parse(JSON.stringify(data[x])));
    console.log("[showAnswer] correctList before update:", JSON.parse(JSON.stringify(correctList)));
    console.log("[showAnswer] wrongList before update:", JSON.parse(JSON.stringify(wrongList)));

    viewing = true;
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';


    var showAnsDiv = document.getElementById("showAnswer");
    var cardAnswerDiv = document.querySelector(".card-answer");
    cardAnswerDiv.style.display = "flex";

    showAnsDiv.innerHTML = data[x].answer.join(' / ') + getAccuracyBadge(currentQuestionAccuracyText);
    if (data[x].answer && data[x].answer.length > 0) {
        const primaryAnswerToSpeak = data[x].answer[0];
        if (primaryAnswerToSpeak) {
            addOrUpdateSpeakButton(primaryAnswerToSpeak, showAnsDiv);
        }
    }
    updateUnknown();
    showExplanation();
    console.log("[showAnswer] correctList after update:", JSON.parse(JSON.stringify(correctList)));
    console.log("[showAnswer] wrongList after update:", JSON.parse(JSON.stringify(wrongList)));


    console.log("[showAnswer] Exiting. viewing:", viewing);
}

function restoreAnswerUI() {
    console.log("[restoreAnswerUI] Called for index:", x);
    if (!data || x === undefined || !data[x]) return;

    viewing = true;
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';

    var showAnsDiv = document.getElementById("showAnswer");
    var cardAnswerDiv = document.querySelector(".card-answer");
    cardAnswerDiv.style.display = "flex";

    // Determine if it was correct or wrong for display purposes (optional, default to answer display)
    // For simplicity, we just show the standard answer display
    showAnsDiv.innerHTML = data[x].answer.join(' / ') + getAccuracyBadge(currentQuestionAccuracyText);
    if (data[x].answer && data[x].answer.length > 0) {
        const primaryAnswerToSpeak = data[x].answer[0];
        if (primaryAnswerToSpeak) {
            addOrUpdateSpeakButton(primaryAnswerToSpeak, showAnsDiv);
        }
    }
    showExplanation();
}
function showExplanation() {
    var expDiv = document.getElementById("showExplanation");
    expDiv.innerHTML = '';
    const explanationText = data[x]?.explanation?.trim();
    const hasExplanation = explanationText && explanationText !== "\"\"" && explanationText !== "\"\"";

    if (hasExplanation) {
        const sanitizedExplanation = explanationText.replace(/<script.*?>.*?<\/script>/gi, '');
        expDiv.innerHTML = `${sanitizedExplanation}`;
    } else {
        expDiv.innerHTML = `
            <div id="no-explanation-message" style="position: relative; display: inline-block;">
                <i>這題還沒有詳解⋯</i>
            </div>
            <div class="contribution-area" id="contribution-area" style="display: none;">
                <input id="explanation-input" placeholder="請輸入你的詳解⋯" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"></input>
                <button id="submit-explanation-button" onclick="submitContribution()">送出</button>
            </div>
        `;
    }

    const correctEl = document.getElementById("correct");
    const wrongEl = document.getElementById("wrong");
    if (correctEl) correctEl.innerText = sessionCorrect;
    if (wrongEl) wrongEl.innerText = sessionWrong;


    const errorNum = data[x]?.num;
    const numBadge = document.getElementById("explanation-num-badge");
    if (numBadge) {
        numBadge.textContent = errorNum ? `${errorNum}` : "";
        numBadge.style.display = errorNum ? "block" : "none";
    }

    // Handle "我是對的" button visibility
    const iAmRightBtn = document.getElementById("iAmRightBtn");
    if (iAmRightBtn) {
        const currentQuestion = data[x];
        const isInWrongList = currentQuestion && wrongList.some(item => item === currentQuestion || (item.num && item.num === currentQuestion.num && item.path === currentQuestion.path));
        iAmRightBtn.style.display = isInWrongList ? "block" : "none";
    }

    expDiv.style.display = "block";
}

function hideContributionInput() {
    const contribArea = document.getElementById('contribution-area');
    const noExplanationMsg = document.getElementById('no-explanation-message');
    const textarea = document.getElementById('explanation-input');
    const submitButton = document.getElementById('submit-explanation-button');

    if (contribArea) {
        contribArea.style.display = 'none';
        if (textarea) textarea.value = '';
        if (submitButton) {
            submitButton.disabled = false;
            submitButton.classList.remove('loading');
        }
    }
    if (noExplanationMsg) {
        noExplanationMsg.style.display = 'inline';
        noExplanationMsg.innerHTML = '<i>感謝你的貢獻！</i>';
    }
}
function updateScoreDisplay() {
    const scoreDisplay = document.getElementById("score-display");
    if (scoreDisplay) scoreDisplay.textContent = score;

    const correctEl = document.getElementById("correct");
    if (correctEl) correctEl.innerText = sessionCorrect;
    const wrongEl = document.getElementById("wrong");
    if (wrongEl) wrongEl.innerText = sessionWrong;
}
async function submitContribution() {
    let ip = 'unknown';
    try {
        const ipRes = await fetch('https://api.ipify.org?format=json');
        const ipData = await ipRes.json();
        ip = ipData.ip;
    } catch (err) {
        console.error('取得 IP 失敗：', err);
    }
    const os = navigator.platform || 'Unknown OS';
    const ua = navigator.userAgent || '';
    let browser = 'Unknown Browser';
    if (ua.includes('Firefox')) {
        browser = 'Firefox';
    } else if (ua.includes('Safari') && !ua.includes('Chrome')) {
        browser = 'Safari';
    } else if (ua.includes('Chrome')) {
        browser = 'Chrome';
    }
    const now = new Date();
    const hours12 = now.getHours() % 12 || 12;
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const period = now.getHours() >= 12 ? 'PM' : 'AM';
    const formattedDate = `${now.getMonth() + 1}月${now.getDate()}日${hours12}:${minutes}${period}`;


    const playerNameForContrib = (window.currentPlayer && window.currentPlayer.trim() !== "") ? window.currentPlayer : "未設定名稱玩家";
    const contributorInfo = `${playerNameForContrib}[IP: ${ip}, ${os}, ${browser}]（${formattedDate}）：\n`;


    const explanationInput = document.getElementById('explanation-input');
    const explanation = explanationInput.value.trim();
    const submitButton = document.getElementById('submit-explanation-button');

    if (!explanation) {
        showAlertModal("請輸入詳解內容！");
        explanationInput.focus();
        return;
    }

    if (!data || data[x] === undefined) {
        showAlertModal("無法獲取當前問題資料，無法送出。");
        return;
    }

    if (submitButton) {
        submitButton.disabled = true;
        submitButton.classList.add('loading');
    }

    const currentItem = data[x];
    const num = currentItem.num || '';
    const path = currentItem.path || '';
    const answer = Array.isArray(currentItem.answer) ? currentItem.answer.join(' / ') : (currentItem.answer || '');
    const description = currentItem.description || '';
    const content = `${num},${path},${answer},${description},${explanation}`;

    console.log("Sending content:", content);
    const fullContent = contributorInfo + content;
    sendToGoogleDocs(fullContent);
    writeScore(10)
        .then(newTotalScore => {
            if (typeof newTotalScore === 'number') score = newTotalScore;
            updateScoreDisplay();
            showAlertModal(`賺了10分！目前總分數：${newTotalScore}`);
        })
        .catch(err => console.error("寫入分數失敗：", err));
}
window.submitContribution = submitContribution;

function nextProb() {
    console.log("[nextProb] Called. done:", JSON.parse(JSON.stringify(done)));
    if (done.every(d => d)) {
        console.log("[nextProb] All questions in current set are done. Handling end of round.");
        handleEndOfRound();
        return;
    }

    const showAnsDiv = document.getElementById("showAnswer");
    const existingSpeakButton = showAnsDiv.querySelector('.speak-answer-icon-button');
    if (existingSpeakButton) {
        existingSpeakButton.remove();
    }

    viewing = false;
    document.querySelector('.card-answer').style.display = 'none';
    document.querySelector('.answer-input-container').style.visibility = 'visible';
    document.querySelector('.bottom-buttons').style.visibility = 'visible';




    const imageUpdated = updateImage();
    if (!imageUpdated && !done.every(d => d)) {
        console.error("[nextProb] Image not updated, but not all questions are done. This state should not be reached.");
        handleEndOfRound();
        return;
    }

    document.getElementById("answer").value = "";
    document.getElementById("answer").focus();
    const answerInput = document.getElementById("answer");
    const desc = data[x]?.description;
    if (desc && desc.trim() !== "") {
        answerInput.placeholder = desc;
    } else {
        adjustPlaceholder();
    }
    document.getElementById("showAnswer").innerHTML = "";
    document.getElementById("showExplanation").innerHTML = "";
    document.getElementById("showExplanation").style.display = "none";

    console.log("[nextProb] Exiting.");
}
function pickNewImage() {
    console.log("[pickNewImage] Called. Current 'done' array:", JSON.parse(JSON.stringify(done)));
    if (!questionQueue.length) {
        const isMultipleChoice = (data && data.length > 0 && data[0].options !== undefined);
        initializeQuestionQueue(isMultipleChoice);
    }

    if (!questionQueue.length) {
        return -1;
    }

    const selectedIndex = questionQueue.shift();
    // done[selectedIndex] = true; // REMOVED: Only mark as done after answering
    console.log(`[pickNewImage] Selected index: ${selectedIndex}. Updated 'done' array:`, JSON.parse(JSON.stringify(done)));
    preloadUpcomingImages();
    return selectedIndex;
}
function updateImage(isResuming = false) {
    console.log(`[updateImage] Called. isResuming: ${isResuming}. Current x: ${x}`);
    document.querySelector('.loading-screen').style.display = 'flex';
    var imageElement = document.getElementById("image");
    imageElement.classList.remove('loaded');
    imageElement.src = "";

    if (!isResuming) {
        const newX = pickNewImage();
        if (newX === -1) {
            console.log("[updateImage] pickNewImage returned -1, no more images in this set.");
            document.querySelector('.loading-screen').style.display = 'none';
            return false;
        }
        x = newX;
        saveCurrentProgress(); // Save x immediately when moving to new question
    }

    if (x === -1 || data[x] === undefined) {
        console.error(`[updateImage] Invalid question index or data. x: ${x}, data[x]:`, data[x]);
        document.querySelector('.loading-screen').style.display = 'none';
        return false;
    }
    console.log(`[updateImage] Updating image for index x: ${x}. Item:`, JSON.parse(JSON.stringify(data[x])));

    let picref = resolveImagePath(data[x]);

    if (picref) {
        imageElement.setAttribute('src', picref);
        const altText = data[x]?.answer?.[0] || `Parasite image ${x + 1}`;
        imageElement.setAttribute('alt', `Image for: ${altText}`);
        console.log(`[updateImage] Set image src to: ${picref}, alt: Image for: ${altText}`);
    } else {
        console.warn(`[updateImage] No image path found for index ${x}.`);
        imageElement.alt = "Image not available";
        document.querySelector('.loading-screen').style.display = 'none';
    }
    console.log("[updateImage] Exiting.");
    // Update star button state after image changes
    try { updateStarButtonState(); } catch (e) { }
    // Update comment count for the new question
    try { updateCommentCount(); } catch (e) { }
    // Update question stats and progress
    try { updateQuestionStatsAndProgress(); } catch (e) { }
    // Update badge number
    try {
        const errorNum = data[x]?.num;
        const numBadge = document.getElementById("explanation-num-badge");
        if (numBadge) {
            numBadge.textContent = errorNum ? `${errorNum}` : "";
            numBadge.style.display = errorNum ? "block" : "none";
        }
    } catch (e) { }
    return true;
}

function showWrongList() { displayListInModal(wrongList, "你答錯的"); }
function showCorrectList() { displayListInModal(correctList, "你答對的"); }
function escapeHtml(value) {
    if (value === null || value === undefined) {
        return '';
    }
    const stringValue = String(value);
    const escapeMap = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    };
    return stringValue.replace(/[&<>"']/g, match => escapeMap[match] || match);
}
function resolveImagePath(item) {
    if (!item || !item.path) return '';
    let picref = item.path;
    const itemBaseUrl = item.baseUrl || window.currentBaseUrl || '.';
    if (!picref.startsWith('http')) {
        if (!picref.startsWith(itemBaseUrl)) {
            let cleanBase = itemBaseUrl.endsWith('/') ? itemBaseUrl.slice(0, -1) : itemBaseUrl;
            picref = `${cleanBase}/images/${picref}`;
        }
    }
    return picref;
}
function displayListInModal(list, title) {
    let modal = document.getElementById('modal');
    let modalBody = document.getElementById('modalBody');
    let content = `<h2>${title} (${list.length})</h2>`;

    if (list.length === 0) {
        content += `<p>你還沒有${title === "你答對的" ? "答對的" : "答錯的"}欸⋯</p>`;
    } else {
        content += '<ol style="display: flex; flex-direction: column; gap: 20px; padding-left: 20px;">';
        list.forEach(item => {
            if (!item) return;
            content += '<li style="border-bottom: 1px solid var(--border-primary); padding-bottom: 16px;">';
            
            const isMultipleChoice = item.options !== undefined || item.question !== undefined;
            if (isMultipleChoice) {
                // Render Multiple Choice question
                const markedQuestion = typeof marked.parse === 'function' ? marked.parse(item.question) : escapeHtml(item.question);
                content += `<div class="modal-mc-question" style="margin-top: 10px; font-weight: 600; line-height: 1.6;">${markedQuestion}</div>`;
                
                if (item.options) {
                    content += '<ul style="list-style-type: none; padding-left: 12px; margin: 12px 0; display: flex; flex-direction: column; gap: 6px;">';
                    Object.entries(item.options).forEach(([key, val]) => {
                        const isOptCorrect = Array.isArray(item.answer) ? item.answer.includes(key) : key === item.answer;
                        const isOptUserSel = Array.isArray(item.userSelection) ? item.userSelection.includes(key) : key === item.userSelection;
                        
                        let optionStyle = 'padding: 8px 16px; border-radius: 12px; font-size: 0.95rem; line-height: 1.5; display: block;';
                        if (isOptCorrect) {
                            optionStyle += ' background-color: rgba(13, 101, 45, 0.08); color: #0d652d; font-weight: 600; border: 1px solid rgba(13, 101, 45, 0.2);';
                        } else if (isOptUserSel) {
                            optionStyle += ' background-color: rgba(217, 48, 37, 0.08); color: #d93025; font-weight: 600; border: 1px solid rgba(217, 48, 37, 0.2);';
                        } else {
                            optionStyle += ' background-color: transparent; border: 1px solid transparent;';
                        }
                        
                        const valText = typeof marked.parse === 'function' ? marked.parse(val).replace(/^<p>|<\/p>$/g, '') : escapeHtml(val);
                        content += `<li style="${optionStyle}"><strong>${key}</strong>: ${valText}</li>`;
                    });
                    content += '</ul>';
                }
                
                // Render explanation
                const explanationText = item.explanation?.trim();
                if (explanationText && explanationText !== "\"\"") {
                    const sanitizedExplanation = explanationText.replace(/<script.*?>.*?<\/script>/gi, '');
                    content += `<p style="color: var(--text-secondary); margin-top: 12px; line-height: 1.6;"><em>解釋：</em>${sanitizedExplanation}</p>`;
                }
            } else {
                // Original flashcard logic
                const answers = Array.isArray(item.answer) ? item.answer : [];
                const answerText = answers.length ? answers.join(' / ') : 'N/A';
                const primaryAnswer = answers.length ? answers[0] : 'item';
                const resolvedPath = resolveImagePath(item);
                if (resolvedPath) {
                    const sanitizedPath = escapeHtml(resolvedPath);
                    const sanitizedAlt = escapeHtml(primaryAnswer || 'item');
                    content += `<img src="${sanitizedPath}" loading="lazy" decoding="async" style="max-height: 200px; object-fit: contain; margin-bottom: 8px; border-radius: 8px;" alt="請檢查網路連線">`;
                } else { 
                    content += '<p><i>（沒跑出圖片）</i></p>'; 
                }
                const sanitizedAnswer = escapeHtml(answerText);
                content += `<p><strong>答案 </strong>${sanitizedAnswer}</p>`;
                const explanationText = item.explanation?.trim();
                if (explanationText && explanationText !== "\"\"") {
                    const sanitizedExplanation = explanationText.replace(/<script.*?>.*?<\/script>/gi, '');
                    content += `<p style="color: var(--text-secondary); margin-top: 8px;"><em>解釋：</em>${sanitizedExplanation}</p>`;
                }
            }
            const errataValue = item.num !== undefined && item.num !== null && String(item.num).trim() !== ''
                ? String(item.num)
                : 'N/A';
            content += `<p class="modal-errata-number">${escapeHtml(errataValue)}</p>`;
            content += '</li>';
        });
        content += '</ol>';
    }
    modalBody.innerHTML = content;
    modal.style.display = "flex";

    // Re-render LaTeX math within the modal
    if (typeof renderMathInElement === 'function') {
        renderMathInElement(modalBody, {
            delimiters: [
                {left: '$$', right: '$$', display: true},
                {left: '$', right: '$', display: false},
                {left: '\\(', right: '\\)', display: false},
                {left: '\\[', right: '\\]', display: true}
            ],
            throwOnError: false
        });
    }
}
function adjustPlaceholder() {
    const inputElement = document.getElementById('answer');
    if (!inputElement) return;
    const desktopBreakpoint = 1024;
    if (window.innerWidth >= desktopBreakpoint) {
        inputElement.placeholder = '把答案打在這，按 Enter 可直接輸入';
    } else {
        inputElement.placeholder = '把答案打在這';
    }
}
function showAlertModal(message) {
    const modal = document.getElementById('alertModal');
    const body = document.getElementById('alertModalBody');
    body.textContent = message;
    modal.style.display = 'flex';
    modal.style.opacity = '1';
    modal.style.transition = 'opacity 0.5s ease';
    setTimeout(() => {
        modal.style.opacity = '0';
        setTimeout(() => {
            modal.style.display = 'none';
        }, 500);
    }, 3000);
}
window.showAlertModal = showAlertModal;

function showForgotPasswordLink() {
    const forgotPasswordLink = document.getElementById('forgotPasswordLink');
    if (forgotPasswordLink) {
        forgotPasswordLink.style.display = 'inline';

        // 移除之前的事件监听器，避免重复绑定
        const newLink = forgotPasswordLink.cloneNode(true);
        forgotPasswordLink.parentNode.replaceChild(newLink, forgotPasswordLink);

        // 添加点击事件
        newLink.addEventListener('click', async function (e) {
            e.preventDefault();
            const emailInput = document.getElementById('email');
            const email = emailInput ? emailInput.value.trim() : '';
            if (!email) {
                showAlertModal('請先在 Email 欄位輸入您的 Email。');
                return;
            }
            try {
                await sendPasswordResetEmail(auth, email);
                showAlertModal('已寄出重設密碼郵件，請至信箱查收。');
            } catch (error) {
                let msg = '寄送失敗，請稍後再試。';
                switch (error.code) {
                    case 'auth/invalid-email':
                        msg = '電子郵件格式無效。';
                        break;
                    case 'auth/user-not-found':
                        msg = '找不到此電子郵件的帳戶。';
                        break;
                    case 'auth/too-many-requests':
                        msg = '嘗試次數過多，請稍後再試。';
                        break;
                }
                showAlertModal(msg);
            }
        });
    }
}

function hideForgotPasswordLink() {
    const forgotPasswordLink = document.getElementById('forgotPasswordLink');
    if (forgotPasswordLink) {
        forgotPasswordLink.style.display = 'none';
    }
}

function closeAlertModal() {
    document.getElementById('alertModal').style.display = 'none';
}
window.closeAlertModal = closeAlertModal;

window.addEventListener('click', function (event) {
    const modal = document.getElementById('alertModal');
    if (event.target === modal) {
        closeAlertModal();
    }
});

// 暱稱編輯模態框
(function () {
    const nicknameModal = document.getElementById('nicknameModal');
    const closeNicknameModalBtn = document.getElementById('closeNicknameModal');
    const nicknameInput = document.getElementById('nicknameInput');
    const saveNicknameBtn = document.getElementById('saveNicknameBtn');

    function openNicknameModal(prefill) {
        if (nicknameInput) nicknameInput.value = prefill || '';
        if (nicknameModal) {
            nicknameModal.style.display = 'flex';
            nicknameModal.style.opacity = '1';
        }
    }
    function closeNicknameModal() {
        if (nicknameModal) nicknameModal.style.display = 'none';
    }
    window.openNicknameModal = openNicknameModal;

    if (closeNicknameModalBtn) {
        closeNicknameModalBtn.addEventListener('click', closeNicknameModal);
    }
    window.addEventListener('click', function (event) {
        if (event.target === nicknameModal) {
            closeNicknameModal();
        }
    });
    if (saveNicknameBtn) {
        saveNicknameBtn.addEventListener('click', async () => {
            const user = auth.currentUser;
            if (!user) {
                closeNicknameModal();
                showAlertModal('請先登入');
                return;
            }
            const raw = nicknameInput ? nicknameInput.value : '';
            const trimmed = (raw || '').trim();
            if (!trimmed) {
                showAlertModal('暱稱不可為空');
                return;
            }
            try {
                await updateProfile(user, { displayName: trimmed });
                try {
                    const uid = user.uid;
                    const userNodeRef = ref(db, `ntumedsa-quiz/${uid}`);
                    await update(userNodeRef, { name: trimmed });
                } catch (e) {
                    console.warn('同步更新排行榜名稱失敗：', e);
                }
                const currentNameSpan = document.getElementById('greetingName');
                if (currentNameSpan) currentNameSpan.textContent = trimmed;
                window.currentPlayer = trimmed;
                if (typeof fetchLeaderboard === 'function') fetchLeaderboard();
                closeNicknameModal();
            } catch (err) {
                console.error('更新暱稱失敗：', err);
                showAlertModal('更新暱稱失敗');
            }
        });
    }
})();

window.handleMainImageLoad = function handleMainImageLoad(imgElement) {
    if (!imgElement) return;
    imgElement.classList.add('loaded');
    const loadingScreen = document.querySelector('.loading-screen');
    if (loadingScreen) {
        loadingScreen.style.display = 'none';
    }

    const attrSrc = imgElement.getAttribute('src');
    if (attrSrc) {
        preloadedImagePaths.add(attrSrc);
    }

    window.preloadNextImage();
};

window.preloadNextImage = function preloadNextImage() {
    if (typeof preloadUpcomingImages === 'function') {
        preloadUpcomingImages();
    }
};

function updateStarButtonState() {
    const starBtn = document.getElementById('starToggle');
    if (!starBtn) return;
    const isStarred = (typeof x !== 'undefined' && unitStars && unitStars[x]);
    if (isStarred) {
        starBtn.classList.add('active');
        starBtn.textContent = '★';
    } else {
        starBtn.classList.remove('active');
        starBtn.textContent = '☆';
    }
}
const starBtnEl = document.getElementById('starToggle');
if (starBtnEl) {
    starBtnEl.addEventListener('click', async function () {
        if (typeof x === 'undefined' || !unitStars) return;
        unitStars[x] = !unitStars[x];
        updateStarButtonState();

        // Trigger an immediate save of progress to persist the star
        const savedCorrectList = JSON.parse(JSON.stringify(correctList));
        const savedWrongList = JSON.parse(JSON.stringify(wrongList));
        const progressData = {
            data, x, done, correct, wrong, score,
            correctList: savedCorrectList,
            wrongList: savedWrongList,
            mistakesCount,
            unitName: window.currentUnitName || undefined,
            jsonPath: window.currentJsonPath || undefined
        };
        if (window.currentUserUid) {
            saveUnitStarsToFirebase(window.currentJsonPath);
            saveCurrentProgress();
        }
    });
}

// --- Comment System Logic ---
let currentCommentListener = null;

function getCommentPath() {
    if (!data || x === undefined || !data[x]) return null;
    const subjectKey = getSubjectKey();
    const unitKey = toFirebaseSafeKey(window.currentJsonPath);
    const questionNum = data[x].num || `q-${x}`;
    return `comments/${subjectKey}/${unitKey}/${questionNum}`;
}

async function updateCommentCount() {
    const path = getCommentPath();
    if (!path) return;

    const commentRef = ref(db, path);
    try {
        const snapshot = await get(commentRef);
        const count = snapshot.exists() ? Object.keys(snapshot.val()).length : 0;
        document.querySelectorAll('.comment-count-text').forEach(el => {
            el.textContent = `留言 (${count})`;
        });
    } catch (error) {
        console.error("[updateCommentCount] Error:", error);
    }
}

function openComments() {
    const path = getCommentPath();
    if (!path) return;

    document.getElementById('commentDrawer').classList.add('active');

    const commentRef = ref(db, path);
    const commentList = document.getElementById('commentList');
    commentList.innerHTML = '<div class="text-center py-4 text-gray-500">載入中...</div>';

    if (currentCommentListener) off(ref(db, currentCommentListener.path));

    currentCommentListener = onValue(commentRef, (snapshot) => {
        commentList.innerHTML = '';
        if (!snapshot.exists()) {
            commentList.innerHTML = '<div class="text-center py-8 text-gray-400">目前還沒有留言，來當第一個吧！</div>';
            return;
        }

        const comments = snapshot.val();
        Object.keys(comments).forEach(id => {
            const c = comments[id];
            const dateObj = new Date(c.timestamp);
            const rocYear = dateObj.getFullYear() - 1911;
            const formattedDate = `${rocYear}/${dateObj.getMonth() + 1}/${dateObj.getDate()} ${String(dateObj.getHours()).padStart(2, '0')}:${String(dateObj.getMinutes()).padStart(2, '0')}`;

            const item = document.createElement('div');
            item.className = 'comment-item';
            item.innerHTML = `
                <div class="comment-meta">
                    <span class="comment-author">${escapeHtml(c.userName)}</span>
                    <span class="comment-time">${formattedDate}</span>
                </div>
                <div class="comment-text">${escapeHtml(c.text)}</div>
            `;
            commentList.appendChild(item);
        });
        commentList.scrollTop = commentList.scrollHeight;
    });
    currentCommentListener.path = path;
}

function closeComments() {
    document.getElementById('commentDrawer').classList.remove('active');
    if (currentCommentListener) {
        off(ref(db, currentCommentListener.path));
        currentCommentListener = null;
    }
}

async function sendComment() {
    if (!auth.currentUser) {
        showAlertModal("請先登入才能留言！");
        return;
    }

    const input = document.getElementById('commentInput');
    const text = input.value.trim();
    if (!text) return;

    const path = getCommentPath();
    if (!path) return;

    const commentRef = ref(db, path);
    const newComment = {
        uid: auth.currentUser.uid,
        userName: auth.currentUser.displayName || auth.currentUser.email.split('@')[0],
        text: text,
        timestamp: Date.now()
    };

    try {
        await push(commentRef, newComment);
        input.value = '';
        updateCommentCount();
    } catch (error) {
        console.error("[sendComment] Error:", error);
        showAlertModal("發送失敗，請稍後再試。");
    }
}

// Comment Event Listeners
document.getElementById('toggleComments')?.addEventListener('click', openComments);
document.getElementById('toggleCommentsInner')?.addEventListener('click', openComments);
document.getElementById('closeComments')?.addEventListener('click', closeComments);
document.getElementById('sendCommentBtn')?.addEventListener('click', sendComment);
document.getElementById('commentInput')?.addEventListener('keydown', (e) => {
    if (isComposing) return;
    if (e.key === 'Enter') {
        e.stopPropagation();
        sendComment();
    }
});

async function handleIAmRight() {
    const currentQuestion = data[x];
    if (!currentQuestion) return;

    // Find the question in wrongList
    const idx = wrongList.findIndex(item => item === currentQuestion || (item.num && item.num === currentQuestion.num && item.path === currentQuestion.path));
    if (idx !== -1) {
        // Remove from wrongList
        wrongList.splice(idx, 1);
        // Add to correctList if not already there
        if (!correctList.includes(currentQuestion)) {
            correctList.push(currentQuestion);
        }

        // Update session stats
        if (sessionWrong > 0) sessionWrong--;
        sessionCorrect++;

        // Update UI
        document.getElementById("wrong").innerText = sessionWrong;
        document.getElementById("correct").innerText = sessionCorrect;

        // Correct the database stats: finalScore = 0, correctInc = 1, wrongInc = -1
        try {
            const result = await writeScore(0, 1, -1);
            if (result && typeof result.score === 'number') {
                score = result.score;
                correct = result.correct;
                wrong = result.wrong;
                updateRankLocally();
            }
            updateScoreDisplay();
            saveCurrentProgress();
        } catch (err) {
            console.error("[handleIAmRight] Error writing score:", err);
        }

        showAlertModal("已將此題變更為回答正確！");

        // Hide the button
        const btn = document.getElementById("iAmRightBtn");
        if (btn) btn.style.display = "none";
    } else {
        showAlertModal("此題尚未被記錄為錯誤。");
    }
}

document.getElementById('iAmRightBtn')?.addEventListener('click', handleIAmRight);

init();

function getSessionState() {
    return {
        get data() { return data; },
        set data(val) { data = val; },
        get x() { return x; },
        set x(val) { x = val; },
        get done() { return done; },
        set done(val) { done = val; },
        get correct() { return correct; },
        set correct(val) { correct = val; },
        get wrong() { return wrong; },
        set wrong(val) { wrong = val; },
        get sessionCorrect() { return sessionCorrect; },
        set sessionCorrect(val) { sessionCorrect = val; },
        get sessionWrong() { return sessionWrong; },
        set sessionWrong(val) { sessionWrong = val; },
        get viewing() { return viewing; },
        set viewing(val) { viewing = val; },
        get score() { return score; },
        set score(val) { score = val; },
        get correctList() { return correctList; },
        set correctList(val) { correctList = val; },
        get wrongList() { return wrongList; },
        set wrongList(val) { wrongList = val; },
        get questionQueue() { return questionQueue; },
        set questionQueue(val) { questionQueue = val; },
        get numOfProbs() { return numOfProbs; },
        set numOfProbs(val) { numOfProbs = val; },
        get mistakesCount() { return mistakesCount; },
        set mistakesCount(val) { mistakesCount = val; },
        get unitStars() { return unitStars; },
        set unitStars(val) { unitStars = val; }
    };
}

export {
    db,
    auth,
    isComposing,
    mistakesCount,
    unitStars,
    currentQuestionAccuracyText,
    currentQuestionCorrectCount,
    currentQuestionTotalCount,
    getSubjectKey,
    toFirebaseSafeKey,
    saveProgressToFirebase,
    saveCurrentProgress,
    loadProgressFromFirebase,
    removeProgressFromFirebase,
    getQuestionStatsPath,
    recordQuestionAttempt,
    updateQuestionStatsAndProgress,
    writeScore,
    fetchLeaderboard,
    updateRankLocally,
    updateStarButtonState,
    resolveImagePath,
    showCorrectList,
    showWrongList,
    saveUnitStarsToFirebase,
    showAlertModal,
    getSessionState
};
