import {
    auth,
    db,
    isComposing,
    saveCurrentProgress,
    writeScore,
    recordQuestionAttempt,
    updateQuestionStatsAndProgress,
    showAlertModal,
    getSessionState,
    saveUnitStarsToFirebase,
    showCorrectList,
    showWrongList,
    getSubjectKey,
    toFirebaseSafeKey,
    currentQuestionAccuracyText
} from './main.js';

import {
    ref,
    onValue,
    push,
    off,
    get
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";

// DOM References
const container = document.getElementById('multipleChoiceContainer');
const questionTextEl = document.getElementById('mc-question-text');
const optionsContainerEl = document.getElementById('mc-options-container');
const explanationCardEl = document.getElementById('mcExplanationCard');
const explanationTextEl = document.getElementById('mcExplanationText');
const originBadgeEl = document.getElementById('mc-origin');
const confirmBtnEl = document.getElementById('mcConfirmBtn');
const nextBtnEl = document.getElementById('mcNextBtn');

const state = getSessionState();

let selectedOption = null;  // For single select (string key)
let selectedOptions = [];   // For multi-select (array of string keys)
let acceptingAnswers = true;
let currentJsonPathGlobal = '';
let viewingIndex = -1;
let timerFrameId = null;

function isSameQuestion(q1, q2) {
    if (!q1 || !q2) return false;
    if (q1 === q2) return true;
    if (q1.question && q1.question === q2.question) return true;
    if (q1.path && q1.path === q2.path) return true;
    if (q1.num && q1.num === q2.num) return true;
    return false;
}


// LateX rendering helper
function renderLatex(element) {
    if (typeof renderMathInElement === 'function') {
        renderMathInElement(element, {
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

// Timer Logic
function startTimer() {
    stopTimer();
    const duration = 15000; // 15 seconds
    const endTime = Date.now() + duration;

    const timerDisplay = document.getElementById('mcTimer');
    if (!timerDisplay) return;
    timerDisplay.innerHTML = '';
    timerDisplay.style.display = 'inline-flex';

    function loop() {
        const now = Date.now();
        let remaining = endTime - now;

        if (remaining < 0) remaining = 0;

        const pct = (remaining / duration) * 100;
        timerDisplay.style.setProperty('--progress', `${pct}%`);

        if (remaining <= 5000) {
            timerDisplay.classList.add('critical');
        } else {
            timerDisplay.classList.remove('critical');
        }

        if (remaining > 0) {
            timerFrameId = requestAnimationFrame(loop);
        } else {
            timerDisplay.classList.remove('critical');
            if (acceptingAnswers) {
                handleTimeout();
            }
        }
    }
    loop();
}

function stopTimer() {
    if (timerFrameId) {
        cancelAnimationFrame(timerFrameId);
        timerFrameId = null;
    }
}

function handleTimeout() {
    if (!acceptingAnswers) return;
    showAlertModal("時間到！");
    confirmAnswer();
}

export function startMultipleChoiceQuiz(jsonData, jsonPath, unitName) {
    console.log("[mc] startMultipleChoiceQuiz");
    currentJsonPathGlobal = jsonPath;
    
    // Normalize q.answer array in multiple choice context
    jsonData.forEach(q => {
        if (Array.isArray(q.answer) && q.answer.length === 1) {
            q.answer = q.answer[0];
        }
    });

    const quizTitleEl = document.getElementById('mcQuizTitle');
    if (quizTitleEl) {
        quizTitleEl.textContent = `${unitName || '生理學'} ｜ 選擇題`;
    }

    // Transition UI
    document.querySelector('.start-screen').style.display = 'none';
    const mainHeader = document.getElementById('mainHeader');
    if (mainHeader) mainHeader.style.display = 'none';
    document.querySelector('.flashcard-container').style.display = 'none';
    container.style.display = 'flex';

    setupEventListeners();
    createProgressDots();
    nextQuestion();
}

export function resumeMultipleChoiceQuiz(jsonData, jsonPath, unitName, prog) {
    console.log("[mc] resumeMultipleChoiceQuiz");
    currentJsonPathGlobal = jsonPath;

    // Normalize q.answer array in multiple choice context
    jsonData.forEach(q => {
        if (Array.isArray(q.answer) && q.answer.length === 1) {
            q.answer = q.answer[0];
        }
    });

    const quizTitleEl = document.getElementById('mcQuizTitle');
    if (quizTitleEl) {
        quizTitleEl.textContent = `${unitName || '生理學'} ｜ 選擇題`;
    }

    // Transition UI
    document.querySelector('.start-screen').style.display = 'none';
    const mainHeader = document.getElementById('mainHeader');
    if (mainHeader) mainHeader.style.display = 'none';
    document.querySelector('.flashcard-container').style.display = 'none';
    container.style.display = 'flex';

    setupEventListeners();
    createProgressDots();

    // Ensure the current active question index is not in the queue to prevent duplicate rendering
    if (state.questionQueue && state.questionQueue.includes(state.x)) {
        state.questionQueue = state.questionQueue.filter(idx => idx !== state.x);
    }

    if (state.done.every(d => d)) {
        handleEndOfRound();
    } else if (state.done[state.x] === true) {
        viewQuestion(state.x);
    } else {
        selectedOption = null;
        selectedOptions = [];
        acceptingAnswers = true;
        viewQuestion(state.x);
    }
}

function setupEventListeners() {
    document.removeEventListener("keydown", enterKeyEvent);
    document.addEventListener("keydown", enterKeyEvent);

    confirmBtnEl.removeEventListener("click", confirmAnswer);
    confirmBtnEl.addEventListener("click", confirmAnswer);

    nextBtnEl.removeEventListener("click", nextQuestion);
    nextBtnEl.addEventListener("click", nextQuestion);

    // Bind Back Progress Buttons
    const backBtn = document.getElementById('mcBackProgressBtn');
    const backBtnExpl = document.getElementById('mcBackProgressBtnExpl');
    if (backBtn) {
        backBtn.removeEventListener("click", goBackToCurrentProgress);
        backBtn.addEventListener("click", goBackToCurrentProgress);
    }
    if (backBtnExpl) {
        backBtnExpl.removeEventListener("click", goBackToCurrentProgress);
        backBtnExpl.addEventListener("click", goBackToCurrentProgress);
    }

    // Bind Star Toggle Button
    const starBtn = document.getElementById('mcStarToggle');
    if (starBtn) {
        starBtn.removeEventListener('click', toggleStar);
        starBtn.addEventListener('click', toggleStar);
    }

    // Bind correct/wrong count clicks to display correct/wrong lists
    const mcCorrectArea = document.getElementById("mcCorrectArea");
    const mcWrongArea = document.getElementById("mcWrongArea");
    if (mcCorrectArea) {
        mcCorrectArea.removeEventListener("click", showCorrectList);
        mcCorrectArea.addEventListener("click", showCorrectList);
    }
    if (mcWrongArea) {
        mcWrongArea.removeEventListener("click", showWrongList);
        mcWrongArea.addEventListener("click", showWrongList);
    }

    // Bind modal close button and backdrop — required since startGame() (flashcard) may not run
    const closeModalBtn = document.getElementById('closeModal');
    if (closeModalBtn) {
        closeModalBtn.onclick = function () {
            document.getElementById('modal').style.display = 'none';
        };
    }
    window.addEventListener('click', function (event) {
        const regularModal = document.getElementById('modal');
        if (event.target === regularModal) {
            regularModal.style.display = 'none';
        }
    });

    // Bind 我是對的 button
    const mcIAmRightBtn = document.getElementById('mcIAmRightBtn');
    if (mcIAmRightBtn) {
        mcIAmRightBtn.removeEventListener('click', handleMcIAmRight);
        mcIAmRightBtn.addEventListener('click', handleMcIAmRight);
    }



    // Bind Dont Know Button click
    const mcDontKnowBtn = document.getElementById('mcDontKnowBtn');
    if (mcDontKnowBtn) {
        mcDontKnowBtn.removeEventListener("click", dontKnow);
        mcDontKnowBtn.addEventListener("click", dontKnow);
    }

    // Bind typing input field
    const answerInputEl = document.getElementById('mcAnswerInput');
    if (answerInputEl) {
        answerInputEl.removeEventListener("input", handleInputTyping);
        answerInputEl.addEventListener("input", handleInputTyping);
    }
}

function enterKeyEvent(event) {
    if (isComposing) return;
    if (event.key === 'Enter') {
        const commentInput = document.getElementById('commentInput');
        if (commentInput && document.activeElement === commentInput) return;

        if (acceptingAnswers && !confirmBtnEl.disabled) {
            confirmAnswer();
        } else if (!acceptingAnswers && nextBtnEl.style.display !== 'none') {
            nextQuestion();
        }
    } else if (acceptingAnswers) {
        // Keyboard shortcuts A, B, C, D (case-insensitive)
        const key = event.key.toUpperCase();
        if (['A', 'B', 'C', 'D', 'E', 'F'].includes(key)) {
            const btn = optionsContainerEl.querySelector(`[data-option="${key}"]`);
            if (btn) btn.click();
        }
    }
}

function goBackToCurrentProgress() {
    viewQuestion(state.x);
}



function dontKnow() {
    if (!acceptingAnswers) return;
    stopTimer();
    acceptingAnswers = false;
    confirmBtnEl.style.display = 'none';
    nextBtnEl.style.display = 'block';

    const q = state.data[state.x];
    const isMulti = Array.isArray(q.answer) && q.answer.length > 1;
    q.userSelection = isMulti ? [] : null;
    q.isCorrect = false;
    state.done[state.x] = true;

    updateWrong();
    viewQuestion(state.x);
    saveCurrentProgress();
}

function handleInputTyping(event) {
    if (!acceptingAnswers) return;
    const text = event.target.value.trim().toUpperCase();
    const q = state.data[state.x];
    
    if (q.isMultiSelect) {
        const letters = text.split(/[\s,+/]+/).filter(l => ['A', 'B', 'C', 'D', 'E', 'F'].includes(l));
        selectedOptions = [...new Set(letters)];
        optionsContainerEl.querySelectorAll('.option-button').forEach(btn => {
            const option = btn.dataset.option;
            if (selectedOptions.includes(option)) {
                btn.classList.add('selected');
            } else {
                btn.classList.remove('selected');
            }
        });
        confirmBtnEl.disabled = selectedOptions.length === 0;
    } else {
        const lastChar = text.slice(-1);
        if (['A', 'B', 'C', 'D', 'E', 'F'].includes(lastChar)) {
            selectedOption = lastChar;
            optionsContainerEl.querySelectorAll('.option-button').forEach(btn => {
                const option = btn.dataset.option;
                if (option === selectedOption) {
                    btn.classList.add('selected');
                } else {
                    btn.classList.remove('selected');
                }
            });
            confirmBtnEl.disabled = false;
        } else if (text === "") {
            selectedOption = null;
            optionsContainerEl.querySelectorAll('.option-button').forEach(btn => btn.classList.remove('selected'));
            confirmBtnEl.disabled = true;
        }
    }
}

function nextQuestion() {
    stopTimer();
    if (state.done.every(d => d)) {
        if (state.wrongList && state.wrongList.length > 0) {
            redoWrongQuestions();
        } else {
            handleEndOfRound();
        }
        return;
    }

    selectedOption = null;
    selectedOptions = [];
    acceptingAnswers = true;

    confirmBtnEl.style.display = 'block';
    confirmBtnEl.disabled = true;
    nextBtnEl.style.display = 'none';
    explanationCardEl.style.display = 'none';

    // Pick next question index
    if (!state.questionQueue.length) {
        handleEndOfRound();
        return;
    }

    state.x = state.questionQueue.shift();
    saveCurrentProgress();

    viewQuestion(state.x);
}

function redoWrongQuestions() {
    console.log("[mc] Redoing wrong questions. Mistakes count:", state.wrongList.length);
    const wrongQs = [...state.wrongList];
    
    // Clean user selections for the new attempt
    wrongQs.forEach(q => {
        if (q.userSelection !== undefined) {
            delete q.userSelection;
        }
        if (q.isCorrect !== undefined) {
            delete q.isCorrect;
        }
    });

    state.data = wrongQs;
    state.done = new Array(wrongQs.length).fill(false);
    state.wrongList = [];
    state.correctList = [];
    state.sessionCorrect = 0;
    state.sessionWrong = 0;

    state.questionQueue = Array.from({length: wrongQs.length}, (_, i) => i);
    state.x = state.questionQueue.shift();

    selectedOption = null;
    selectedOptions = [];
    acceptingAnswers = true;

    confirmBtnEl.style.display = 'block';
    confirmBtnEl.disabled = true;
    nextBtnEl.style.display = 'none';
    explanationCardEl.style.display = 'none';

    createProgressDots();
    viewQuestion(state.x);
    saveCurrentProgress();
}

async function viewQuestion(index) {
    viewingIndex = index;
    const q = state.data[index];
    if (!q) return;

    // Set stats UI elements
    updateStatsUI(index);

    // Check Multi-select
    q.isMultiSelect = Array.isArray(q.answer) && q.answer.length > 1;

    // Render Origin Badge
    const originBadgeEl = document.getElementById('mc-origin');
    if (q.origin) {
        originBadgeEl.textContent = q.origin;
        originBadgeEl.style.display = 'block';
    } else {
        originBadgeEl.style.display = 'none';
    }

    // Render Question Text
    let label = '';
    if (q.isMultiSelect) {
        label = '<span class="multi-label">複選</span>';
    }
    const markedQuestion = typeof marked.parse === 'function' ? marked.parse(q.question) : q.question;
    questionTextEl.innerHTML = `
        <div class="question-wrapper" style="display: flex; flex-direction: column; align-items: flex-start; gap: 8px;">
            ${label}
            <div class="question-text" style="width: 100%;">${markedQuestion}</div>
        </div>
    `;
    renderLatex(questionTextEl);

    // Render Options list
    optionsContainerEl.innerHTML = '';
    if (q.options) {
        Object.entries(q.options).forEach(([key, value]) => {
            const button = document.createElement('button');
            button.className = 'option-button';
            button.dataset.option = key;
            const markedVal = typeof marked.parse === 'function' ? marked.parse(value).replace(/^<p>|<\/p>$/g, '') : value;
            button.innerHTML = `${key}: ${markedVal}`;
            renderLatex(button);

            // Handle historical states
            const isConfirmed = state.done[index];
            if (isConfirmed) {
                const userSel = q.userSelection;
                if (q.isMultiSelect) {
                    const userSelArr = Array.isArray(userSel) ? userSel : [];
                    if (userSelArr.includes(key)) {
                        button.classList.add('selected');
                    }
                    if (Array.isArray(q.answer) && q.answer.includes(key)) {
                        if (userSelArr.includes(key)) {
                            button.classList.add('correct');
                        } else {
                            button.classList.add('missing');
                        }
                    } else if (userSelArr.includes(key)) {
                        button.classList.add('incorrect');
                    }
                } else {
                    if (userSel === key) {
                        button.classList.add('selected');
                    }
                    if (key === q.answer) {
                        button.classList.add('correct');
                    } else if (userSel === key) {
                        button.classList.add('incorrect');
                    }
                }
            } else {
                // If it is the current active question and not confirmed, register click listener
                if (index === state.x) {
                    button.addEventListener('click', selectOption);
                    if (q.isMultiSelect) {
                        if (selectedOptions.includes(key)) {
                            button.classList.add('selected');
                        }
                    } else {
                        if (selectedOption === key) {
                            button.classList.add('selected');
                        }
                    }
                }
            }
            optionsContainerEl.appendChild(button);
        });
    }

    // Show/Hide Explanation Panel
    const isConfirmed = state.done[index];
    if (isConfirmed) {
        // Fetch accuracy rate for the question from Firebase
        let percentText = 'N/A';
        try {
            const subjectKey = getSubjectKey();
            const unitKey = toFirebaseSafeKey(window.currentJsonPath);
            const questionNum = q.num || `q-${index}`;
            const path = `question-stats/${subjectKey}/${unitKey}/${questionNum}`;
            const statsRef = ref(db, path);
            const snapshot = await get(statsRef);
            if (snapshot.exists()) {
                const val = snapshot.val();
                const correctCount = val.correctCount || 0;
                const totalCount = val.totalCount || 0;
                if (totalCount > 0) {
                    percentText = `${Math.round((correctCount / totalCount) * 100)}%`;
                }
            }
        } catch (e) {
            console.error("[MC] Error fetching accuracy rate:", e);
        }

        const explanationText = q.explanation?.trim() || '';
        let explHtml = '';
        if (explanationText && explanationText !== '""') {
            const markedExpl = typeof marked.parse === 'function' ? marked.parse(explanationText) : explanationText;
            explHtml = markedExpl.replace(/<script.*?>.*?<\/script>/gi, '');
        } else {
            explHtml = '<i>這題目前還沒有詳解。</i>';
        }

        // Prepend the accuracy rate badge if available
        let badgeHtml = '';
        if (percentText && percentText !== 'N/A') {
            badgeHtml = `<div style="margin-bottom: 12px; display: flex; justify-content: center;"><span class="accuracy-badge" style="padding: 4px 10px; background-color: var(--md-sys-color-primary-container, #e8f0fe); color: var(--md-sys-color-primary, #0b57d0); border-radius: 8px; font-size: 0.8rem; font-weight: 700; display: inline-flex; align-items: center; vertical-align: middle;">答對率 ${percentText}</span></div>`;
        }

        explanationTextEl.innerHTML = badgeHtml + explHtml;
        renderLatex(explanationTextEl);
        explanationCardEl.style.display = 'flex';
    } else {
        explanationCardEl.style.display = 'none';
    }

    // Set buttons and inputs display
    const backBtn = document.getElementById('mcBackProgressBtn');
    const backBtnExpl = document.getElementById('mcBackProgressBtnExpl');
    const mcDontKnowBtn = document.getElementById('mcDontKnowBtn');
    const answerInputEl = document.getElementById('mcAnswerInput');

    if (answerInputEl) {
        answerInputEl.disabled = isConfirmed;
        if (!isConfirmed) {
            if (q.isMultiSelect) {
                answerInputEl.value = selectedOptions.sort().join(' ');
            } else {
                answerInputEl.value = selectedOption || "";
            }
        } else {
            if (q.isMultiSelect) {
                answerInputEl.value = Array.isArray(q.userSelection) ? q.userSelection.sort().join(' ') : "";
            } else {
                answerInputEl.value = q.userSelection || "";
            }
        }
    }

    // Show 我是對的 only when this confirmed question is in the wrongList
    const mcIAmRightBtn = document.getElementById('mcIAmRightBtn');
    if (mcIAmRightBtn) {
        if (isConfirmed) {
            const isInWrongList = state.wrongList.some(item => isSameQuestion(item, q));
            mcIAmRightBtn.style.display = isInWrongList ? 'inline-block' : 'none';
        } else {
            mcIAmRightBtn.style.display = 'none';
        }
    }

    if (index === state.x) {
        // We are on the current active question
        if (backBtn) backBtn.style.display = 'none';
        if (backBtnExpl) backBtnExpl.style.display = 'none';
        if (mcDontKnowBtn) mcDontKnowBtn.style.display = isConfirmed ? 'none' : 'block';
        acceptingAnswers = !isConfirmed;

        if (isConfirmed) {
            confirmBtnEl.style.display = 'none';
            nextBtnEl.style.display = 'block';
            stopTimer();
            if (state.done.every(d => d) && state.wrongList && state.wrongList.length > 0) {
                nextBtnEl.textContent = "重做錯題";
            } else {
                nextBtnEl.textContent = "下一題";
            }
        } else {
            confirmBtnEl.style.display = 'block';
            if (q.isMultiSelect) {
                confirmBtnEl.disabled = selectedOptions.length === 0;
            } else {
                confirmBtnEl.disabled = selectedOption === null;
            }
            nextBtnEl.style.display = 'none';
        }
    } else {
        // We are viewing a past/future question
        if (backBtn) backBtn.style.display = isConfirmed ? 'none' : 'block';
        if (backBtnExpl) backBtnExpl.style.display = isConfirmed ? 'block' : 'none';
        if (mcDontKnowBtn) mcDontKnowBtn.style.display = 'none';
        confirmBtnEl.style.display = 'none';
        nextBtnEl.style.display = 'none';
        acceptingAnswers = false;
        stopTimer();
    }

    updateDotsUI();
    updateStarsUI();

    // Fire main.js actions for statistics preloading
    if (window.updateCommentCount) window.updateCommentCount();
    if (window.updateQuestionStatsAndProgress) window.updateQuestionStatsAndProgress();
}

function selectOption(event) {
    if (!acceptingAnswers) return;
    const btn = event.currentTarget;
    const option = btn.dataset.option;
    const q = state.data[state.x];
    const answerInputEl = document.getElementById('mcAnswerInput');

    if (q.isMultiSelect) {
        if (selectedOptions.includes(option)) {
            selectedOptions = selectedOptions.filter(o => o !== option);
            btn.classList.remove('selected');
        } else {
            selectedOptions.push(option);
            btn.classList.add('selected');
        }
        confirmBtnEl.disabled = selectedOptions.length === 0;
        if (answerInputEl) {
            answerInputEl.value = selectedOptions.sort().join(' ');
        }
    } else {
        optionsContainerEl.querySelectorAll('.option-button').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        selectedOption = option;
        confirmBtnEl.disabled = false;
        if (answerInputEl) {
            answerInputEl.value = option;
        }
    }
}

function confirmAnswer() {
    stopTimer();
    const q = state.data[state.x];
    if (!q) return;

    acceptingAnswers = false;
    confirmBtnEl.style.display = 'none';
    nextBtnEl.style.display = 'block';

    let isCorrect = false;

    if (q.isMultiSelect) {
        const sortedSelected = [...selectedOptions].sort();
        const sortedAnswer = [...q.answer].sort();
        isCorrect = sortedSelected.length === sortedAnswer.length && sortedSelected.every((val, index) => val === sortedAnswer[index]);
        q.userSelection = [...selectedOptions];
    } else {
        isCorrect = selectedOption === q.answer;
        q.userSelection = selectedOption;
    }

    q.isCorrect = isCorrect;
    state.done[state.x] = true;

    // Apply color highlights to options
    optionsContainerEl.querySelectorAll('.option-button').forEach(btn => {
        const option = btn.dataset.option;
        
        if (q.isMultiSelect) {
            if (selectedOptions.includes(option)) {
                btn.classList.add('selected');
            } else {
                btn.classList.remove('selected');
            }
            if (Array.isArray(q.answer) && q.answer.includes(option)) {
                if (selectedOptions.includes(option)) {
                    btn.classList.add('correct');
                } else {
                    btn.classList.add('missing');
                }
            } else if (selectedOptions.includes(option)) {
                btn.classList.add('incorrect');
            }
        } else {
            if (selectedOption === option) {
                btn.classList.add('selected');
            } else {
                btn.classList.remove('selected');
            }
            if (option === q.answer) {
                btn.classList.add('correct');
            } else if (selectedOption === option) {
                btn.classList.add('incorrect');
            }
        }
    });

    if (isCorrect) {
        updateCorrect();
    } else {
        updateWrong();
    }

    viewQuestion(state.x);
    saveCurrentProgress();
}

function createProgressDots() {
    const container = document.getElementById('mcProgressDots');
    if (!container) return;
    container.innerHTML = '';
    
    state.data.forEach((_, i) => {
        const dot = document.createElement('div');
        dot.className = 'progress-dot';
        dot.setAttribute('data-tooltip', `第 ${i + 1} 題`);
        
        dot.innerHTML = `
            <svg viewBox="0 0 18 18" width="18" height="18" class="progress-dot-svg">
                <circle cx="9" cy="9" r="4" class="dot-fill" />
                <circle cx="9" cy="9" r="5.5" stroke-width="1" fill="none" class="dot-stroke" />
            </svg>
        `;
        
        dot.addEventListener('click', () => {
            viewQuestion(i);
        });
        container.appendChild(dot);
    });
    updateDotsUI();
}

function updateDotsUI() {
    const container = document.getElementById('mcProgressDots');
    if (!container) return;
    const dots = container.querySelectorAll('.progress-dot');
    
    dots.forEach((dot, i) => {
        dot.classList.remove('correct', 'wrong', 'current-progress', 'viewing');
        
        if (state.done[i]) {
            const isCorrect = state.correctList.some(q => isSameQuestion(q, state.data[i]));
            const isWrong = state.wrongList.some(q => isSameQuestion(q, state.data[i]));
            if (isCorrect) {
                dot.classList.add('correct');
            } else if (isWrong) {
                dot.classList.add('wrong');
            }
        }
        
        if (i === state.x) {
            dot.classList.add('current-progress');
        }
        
        if (i === viewingIndex) {
            dot.classList.add('viewing');
        }
    });
}

async function updateCorrect() {
    state.correct++;
    state.sessionCorrect++;
    state.correctList.push(state.data[state.x]);
    recordQuestionAttempt(true);
    try {
        const result = await writeScore(2, 1, 0);
        if (result && typeof result.score === 'number') {
            state.score = result.score;
            if (window.updateRankLocally) window.updateRankLocally();
        }
    } catch (e) {
        console.error('[MC] writeScore failed:', e);
    }
    updateStatsUI(state.x);
}

async function updateWrong() {
    state.wrong++;
    state.sessionWrong++;
    state.wrongList.push(state.data[state.x]);
    recordQuestionAttempt(false);
    if (Array.isArray(state.mistakesCount)) {
        state.mistakesCount[state.x] = (state.mistakesCount[state.x] || 0) + 1;
    }
    try {
        const result = await writeScore(-2, 0, 1);
        if (result && typeof result.score === 'number') {
            state.score = result.score;
            if (window.updateRankLocally) window.updateRankLocally();
        }
    } catch (e) {
        console.error('[MC] writeScore failed:', e);
    }
    updateStatsUI(state.x);
}

function updateStatsUI(index) {
    const wrongEl = document.getElementById('mcWrong');
    const correctEl = document.getElementById('mcCorrect');
    if (wrongEl) wrongEl.textContent = state.sessionWrong;
    if (correctEl) correctEl.textContent = state.sessionCorrect;
    
    const scoreEl = document.getElementById('mc-score-display');
    const progressEl = document.getElementById('mc-progress-display');
    const rankEl = document.getElementById('mc-rank-display');
    
    // Show 1-based current question number (how many have been seen including current)
    const completed = state.done.filter(Boolean).length;
    const total = state.done.length;
    const displayNum = total - (state.questionQueue ? state.questionQueue.length : 0);
    
    if (scoreEl) scoreEl.textContent = state.score;
    if (progressEl) {
        progressEl.innerHTML = `
            <div style="display: inline-flex; align-items: center; justify-content: center; position: relative; font-family: 'Outfit', sans-serif;">
                <span style="font-size: 1.25rem; font-weight: 800; color: var(--md-sys-color-primary); transform: translateY(-3px); line-height: 1;">${displayNum}</span>
                <span style="font-size: 1.25rem; font-weight: 300; opacity: 0.35; transform: rotate(16deg) scaleY(1.25) translateY(-1px); margin: 0; color: var(--text-secondary); line-height: 1;">/</span>
                <span style="font-size: 0.9rem; font-weight: 600; opacity: 0.6; transform: translateY(4px); color: var(--text-secondary); line-height: 1;">${total}</span>
            </div>
        `;
    }
    
    if (window.updateRankLocally) {
        window.updateRankLocally();
    }
    const globalRankEl = document.getElementById('rank-display');
    if (rankEl && globalRankEl) {
        rankEl.textContent = globalRankEl.textContent;
    }
}

function updateStarsUI() {
    const starBtn = document.getElementById('mcStarToggle');
    if (!starBtn) return;
    const isStarred = (viewingIndex !== -1 && state.unitStars && state.unitStars[viewingIndex]);
    if (isStarred) {
        starBtn.classList.add('starred');
    } else {
        starBtn.classList.remove('starred');
    }
}

async function toggleStar() {
    if (viewingIndex === -1 || !state.unitStars) return;
    state.unitStars[viewingIndex] = !state.unitStars[viewingIndex];
    updateStarsUI();

    if (window.currentUserUid) {
        saveUnitStarsToFirebase(currentJsonPathGlobal);
        saveCurrentProgress();
    }
}

function handleEndOfRound() {
    stopTimer();
    if (window.handleEndOfRound) {
        window.handleEndOfRound();
    }
}

async function handleMcIAmRight() {
    const q = state.data[state.x];
    if (!q) return;

    const idx = state.wrongList.findIndex(item => isSameQuestion(item, q));
    if (idx === -1) {
        showAlertModal('此題尚未被記錄為錯誤。');
        return;
    }

    // Move from wrongList → correctList
    state.wrongList.splice(idx, 1);
    if (!state.correctList.some(item => isSameQuestion(item, q))) {
        state.correctList.push(q);
    }

    // Update session stats
    if (state.sessionWrong > 0) state.sessionWrong--;
    state.sessionCorrect++;

    // Update Firebase score: no bonus points, but correct +1, wrong -1
    try {
        const result = await writeScore(0, 1, -1);
        if (result && typeof result.score === 'number') {
            state.score = result.score;
            if (window.updateRankLocally) window.updateRankLocally();
        }
    } catch (e) {
        console.error('[MC] handleMcIAmRight writeScore failed:', e);
    }

    // Refresh UI
    const mcIAmRightBtn = document.getElementById('mcIAmRightBtn');
    if (mcIAmRightBtn) mcIAmRightBtn.style.display = 'none';
    updateStatsUI(state.x);
    updateDotsUI();
    saveCurrentProgress();
    showAlertModal('已將此題變更為回答正確！');
}
