import {
    auth,
    db,
    isComposing,
    saveCurrentProgress,
    writeScore,
    recordQuestionAttempt,
    updateQuestionStatsAndProgress,
    showAlertModal,
    resolveImagePath,
    getSessionState,
    updateStarButtonState,
    saveUnitStarsToFirebase,
    getQuestionStatsPath
} from './main.js';

import {
    ref,
    onValue,
    push,
    off,
    get
} from "https://www.gstatic.com/firebasejs/12.12.1/firebase-database.js";

// DOM References
const flashcardContainer = document.querySelector('.flashcard-container');
const imageElement = document.getElementById("image");
const loadingScreen = document.querySelector('.loading-screen');
const answerInput = document.getElementById("answer");
const showAnsDiv = document.getElementById("showAnswer");
const showExplanationDiv = document.getElementById("showExplanation");
const cardAnswerOverlay = document.querySelector(".card-answer");
const iAmRightBtn = document.getElementById("iAmRightBtn");

let tm;
const state = getSessionState();

function isSameQuestion(q1, q2) {
    if (!q1 || !q2) return false;
    if (q1 === q2) return true;
    if (q1.question && q1.question === q2.question) return true;
    if (q1.path && q1.path === q2.path) return true;
    if (q1.num && q1.num === q2.num) return true;
    return false;
}


// Swear words for Easter egg
/*const lowerCaseSwearWords = [
    "幹", "gan", "fuck", "shit", "bitch", "asshole", "crap", "piss", "dick", "pussy"
];*/
// But some answers (e.g. "Sympathetic ganglion") become unavaliable
const lowerCaseSwearWords = [].map(word=>word.toLowerCase());

export function startFlashcardQuiz(jsonData, jsonPath, unitName) {
    console.log("[flashcard] startFlashcardQuiz");
    
    // Transition UI
    document.querySelector('.start-screen').style.display = 'none';
    const mainHeader = document.getElementById('mainHeader');
    if (mainHeader) mainHeader.style.display = 'none';
    flashcardContainer.style.display = 'flex';
    document.getElementById('multipleChoiceContainer').style.display = 'none';

    // Show progress bar and hide progress dots in Flashcard mode
    const progressEl = flashcardContainer.querySelector('.progress');
    if (progressEl) progressEl.style.display = 'flex';
    const progressDots = document.getElementById('fcProgressDots');
    if (progressDots) progressDots.style.display = 'none';

    // Setup listener bindings
    setupEventListeners();

    createProgressDots();
    nextProb();
    try { updateStarsUI(); } catch (e) { }
}

export function resumeFlashcardQuiz(jsonData, jsonPath, unitName, prog) {
    console.log("[flashcard] resumeFlashcardQuiz");
    
    // Transition UI
    document.querySelector('.start-screen').style.display = 'none';
    const mainHeader = document.getElementById('mainHeader');
    if (mainHeader) mainHeader.style.display = 'none';
    flashcardContainer.style.display = 'flex';
    document.getElementById('multipleChoiceContainer').style.display = 'none';

    // Show progress bar and hide progress dots in Flashcard mode
    const progressEl = flashcardContainer.querySelector('.progress');
    if (progressEl) progressEl.style.display = 'flex';
    const progressDots = document.getElementById('fcProgressDots');
    if (progressDots) progressDots.style.display = 'none';

    // Setup listener bindings
    setupEventListeners();

    createProgressDots();

    if (state.done.every(d => d)) {
        handleEndOfRound();
    } else {
        viewQuestion(state.x);
    }
}

function setupEventListeners() {
    document.removeEventListener("keydown", enterKeyEvent);
    document.addEventListener("keydown", enterKeyEvent);

    // Clone submitAnswer to strip old listeners
    const submitBtn = document.getElementById("submitAnswer");
    if (submitBtn) {
        const newSubmitBtn = submitBtn.cloneNode(true);
        submitBtn.parentNode.replaceChild(newSubmitBtn, submitBtn);
        newSubmitBtn.addEventListener("click", submitUserAnswer);
    }

    // Clone dontKnow to strip old listeners
    const dontKnowBtn = document.getElementById("dontKnow");
    if (dontKnowBtn) {
        const newDontKnowBtn = dontKnowBtn.cloneNode(true);
        dontKnowBtn.parentNode.replaceChild(newDontKnowBtn, dontKnowBtn);
        newDontKnowBtn.addEventListener("click", showAnswer);
    }

    // Clone next to strip old listeners
    const nextButton = document.getElementById("next");
    if (nextButton) {
        const newNextButton = nextButton.cloneNode(true);
        nextButton.parentNode.replaceChild(newNextButton, nextButton);
        newNextButton.addEventListener("click", nextProb);
    }

    // Bind Back Progress Buttons
    const backBtn = document.getElementById('fcBackProgressBtn');
    const backBtnExpl = document.getElementById('fcBackProgressBtnExpl');
    if (backBtn) {
        backBtn.removeEventListener("click", goBackToCurrentProgress);
        backBtn.addEventListener("click", goBackToCurrentProgress);
    }
    if (backBtnExpl) {
        backBtnExpl.removeEventListener("click", goBackToCurrentProgress);
        backBtnExpl.addEventListener("click", goBackToCurrentProgress);
    }

    // Intercept/wrap iAmRightBtn click to trigger stats UI refresh
    const iAmRightBtn = document.getElementById("iAmRightBtn");
    if (iAmRightBtn) {
        iAmRightBtn.removeEventListener("click", updateUiAfterIAmRight);
        iAmRightBtn.addEventListener("click", updateUiAfterIAmRight);
    }

    // Bind Star Toggle Button with cloning to remove main.js anonymous listener
    const starBtn = document.getElementById('starToggle');
    if (starBtn) {
        const newStarBtn = starBtn.cloneNode(true);
        starBtn.parentNode.replaceChild(newStarBtn, starBtn);
        newStarBtn.addEventListener('click', async function () {
            const idx = (viewingIndex !== -1) ? viewingIndex : state.x;
            if (idx === -1 || !state.unitStars) return;
            state.unitStars[idx] = !state.unitStars[idx];
            updateStarsUI();
            if (window.currentUserUid) {
                saveUnitStarsToFirebase(window.currentJsonPath);
                saveCurrentProgress();
            }
        });
    }
}

function enterKeyEvent(event) {
    if (isComposing) return;
    if (event.key === 'Enter') {
        const commentInput = document.getElementById('commentInput');
        if (commentInput && document.activeElement === commentInput) return;

        const explanationInput = document.getElementById('explanation-input');
        if (explanationInput && document.activeElement === explanationInput && explanationInput.offsetParent !== null) {
            event.preventDefault();
            // submitContribution is attached globally to window in main.js
            if (window.submitContribution) window.submitContribution();
        } else if (!state.viewing && answerInput.value.trim() !== "") {
            submitUserAnswer();
        } else if (state.viewing && cardAnswerOverlay.style.display === 'flex') {
            const nextBtn = document.getElementById('next');
            if (nextBtn && nextBtn.style.display !== 'none') {
                nextBtn.click();
            }
        }
    }
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
        
        let finalVariants = [];
        variants.forEach(v => {
            let current = [v];
            const localRegex = /\(([^)]+)\)/g;
            let m;
            while ((m = localRegex.exec(v)) !== null) {
                const fullMatch = m[0];
                const innerText = m[1].trim();
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
    console.log("[submitUserAnswer] Called.");
    if (isComposing) return;
    
    var userAnswerRaw = answerInput.value;
    var lowerUserAnswer = userAnswerRaw.replace(/[\p{P}\s]/gu, "").toLowerCase();

    /*if (lowerUserAnswer && lowerCaseSwearWords.some(swearWord => lowerUserAnswer.includes(swearWord))) {
        window.open('https://youtu.be/HmIMmFAV4BY', '_blank');
        answerInput.value = "";
        return;
    }*/ //Prevent swear word identification

    if (state.viewing) return;
    clearTimeout(tm);

    var userAnswer = userAnswerRaw;
    if (userAnswer.replace(/[\p{P}\s]/gu, "") === "") return;

    state.viewing = true;
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';

    cardAnswerOverlay.style.display = "flex";
    const primaryAns = state.data[state.x].answer;

    if (checkAns(userAnswer, primaryAns)) {
        showAnsDiv.innerHTML = primaryAns.map(ans => {
            if (checkAns(userAnswer, [ans])) {
                return `<span style="color: var(--accent-green);">${ans}</span>`;
            }
            return ans;
        }).join(' / ') + getAccuracyBadge();
        if (primaryAns && primaryAns.length > 0) {
            addOrUpdateSpeakButton(primaryAns[0], showAnsDiv);
        }
        updateCorrect();
        showExplanation();
    } else {
        showAnsDiv.innerHTML = `<span style="color: var(--accent-red);">${userAnswer}</span> <span style="opacity: 0.3; margin: 0 8px;">|</span> ${primaryAns.join(' / ')}` + getAccuracyBadge();
        if (primaryAns && primaryAns.length > 0) {
            addOrUpdateSpeakButton(primaryAns[0], showAnsDiv);
        }
        updateWrong();
        showExplanation();
    }
}

function showAnswer() {
    if (state.viewing) return;
    clearTimeout(tm);

    state.viewing = true;
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';

    cardAnswerOverlay.style.display = "flex";
    const primaryAns = state.data[state.x].answer;
    showAnsDiv.innerHTML = primaryAns.join(' / ') + getAccuracyBadge();
    if (primaryAns && primaryAns.length > 0) {
        addOrUpdateSpeakButton(primaryAns[0], showAnsDiv);
    }
    updateUnknown();
    showExplanation();
}

function restoreAnswerUI() {
    if (!state.data || state.x === undefined || !state.data[state.x]) return;

    state.viewing = true;
    document.querySelector('.answer-input-container').style.visibility = 'hidden';
    document.querySelector('.bottom-buttons').style.visibility = 'hidden';

    cardAnswerOverlay.style.display = "flex";
    const primaryAns = state.data[state.x].answer;
    showAnsDiv.innerHTML = primaryAns.join(' / ') + getAccuracyBadge();
    if (primaryAns && primaryAns.length > 0) {
        addOrUpdateSpeakButton(primaryAns[0], showAnsDiv);
    }
    showExplanation();
}

function showExplanation() {
    const expDiv = showExplanationDiv;
    expDiv.innerHTML = '';
    const explanationText = state.data[state.x]?.explanation?.trim();
    const hasExplanation = explanationText && explanationText !== "\"\"";

    if (hasExplanation) {
        expDiv.innerHTML = `${explanationText.replace(/<script.*?>.*?<\/script>/gi, '')}`;
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
    if (correctEl) correctEl.innerText = state.sessionCorrect;
    if (wrongEl) wrongEl.innerText = state.sessionWrong;

    const errorNum = state.data[state.x]?.num;
    const numBadge = document.getElementById("explanation-num-badge");
    if (numBadge) {
        numBadge.textContent = errorNum ? `${errorNum}` : "";
        numBadge.style.display = errorNum ? "block" : "none";
    }

    if (iAmRightBtn) {
        const currentQuestion = state.data[state.x];
        const isInWrongList = currentQuestion && state.wrongList.some(item => isSameQuestion(item, currentQuestion));
        iAmRightBtn.style.display = isInWrongList ? "block" : "none";
    }

    expDiv.style.display = "block";
}

function nextProb() {
    if (state.done.every(d => d)) {
        handleEndOfRound();
        return;
    }

    const existingSpeakButton = showAnsDiv.querySelector('.speak-answer-icon-button');
    if (existingSpeakButton) {
        existingSpeakButton.remove();
    }

    const newX = pickNewImage();
    if (newX === -1) {
        handleEndOfRound();
        return;
    }
    state.x = newX;
    saveCurrentProgress();

    showAnsDiv.innerHTML = "";
    showExplanationDiv.innerHTML = "";
    showExplanationDiv.style.display = "none";
    const numBadge = document.getElementById("explanation-num-badge");
    if(numBadge){
        numBadge.style.display = "none";
    }

    viewQuestion(state.x);
}

function pickNewImage() {
    if (!state.questionQueue.length) {
        return -1;
    }
    const selectedIndex = state.questionQueue.shift();
    return selectedIndex;
}

let viewingIndex = -1;

function updateImage(isResuming = false) {
    loadingScreen.style.display = 'flex';
    imageElement.classList.remove('loaded');
    imageElement.src = "";

    if (!isResuming) {
        const newX = pickNewImage();
        if (newX === -1) {
            loadingScreen.style.display = 'none';
            return false;
        }
        state.x = newX;
        saveCurrentProgress();
    }

    if (state.x === -1 || state.data[state.x] === undefined) {
        loadingScreen.style.display = 'none';
        return false;
    }

    viewingIndex = state.x;

    let picref = resolveImagePath(state.data[state.x]);

    if (picref) {
        imageElement.setAttribute('src', picref);
        const altText = state.data[state.x]?.answer?.[0] || `Parasite image ${state.x + 1}`;
        imageElement.setAttribute('alt', `Image for: ${altText}`);
    } else {
        imageElement.alt = "Image not available";
        loadingScreen.style.display = 'none';
    }

    updateStarsUI();
    // Invoke main.js window scope functions for compatibility
    if (window.updateCommentCount) window.updateCommentCount();
    if (window.updateQuestionStatsAndProgress) window.updateQuestionStatsAndProgress();
    
    try {
        const errorNum = state.data[state.x]?.num;
        const numBadge = document.getElementById("explanation-num-badge");
        if (numBadge) {
            numBadge.textContent = errorNum ? `${errorNum}` : "";
            numBadge.style.display = errorNum ? "block" : "none";
        }
    } catch (e) { }

    updateStatsUI(state.x);
    updateDotsUI();
    return true;
}

function getAccuracyBadge(percentText) {
    if (!percentText || percentText === "N/A") return '';
    return `<span class="accuracy-badge" style="margin-left: 8px; padding: 2px 8px; background-color: var(--md-sys-color-primary-container, #e8f0fe); color: #808ca3; border-radius: 8px; font-size: 0.8rem; font-weight: 700; display: inline-flex; align-items: center; vertical-align: middle;">答對率 ${percentText}</span>`;
}

function addOrUpdateSpeakButton(answerToSpeak, answerDisplayElement) {
    if (window.addOrUpdateSpeakButton) {
        window.addOrUpdateSpeakButton(answerToSpeak, answerDisplayElement);
    }
}

function updateCorrect() {
    state.correct++;
    state.sessionCorrect++;
    state.correctList.push(state.data[state.x]);
    state.done[state.x] = true;
    recordQuestionAttempt(true);
    writeScore(10, 1, 0);
    updateStatsUI(state.x);
    updateDotsUI();
}

function updateWrong() {
    state.wrong++;
    state.sessionWrong++;
    state.wrongList.push(state.data[state.x]);
    state.done[state.x] = true;
    recordQuestionAttempt(false);
    writeScore(0, 0, 1);
    if (Array.isArray(state.mistakesCount)) {
        state.mistakesCount[state.x] = (state.mistakesCount[state.x] || 0) + 1;
    }
    updateStatsUI(state.x);
    updateDotsUI();
}

function updateUnknown() {
    state.wrong++;
    state.sessionWrong++;
    state.wrongList.push(state.data[state.x]);
    state.done[state.x] = true;
    recordQuestionAttempt(false);
    writeScore(0, 0, 1);
    if (Array.isArray(state.mistakesCount)) {
        state.mistakesCount[state.x] = (state.mistakesCount[state.x] || 0) + 1;
    }
    updateStatsUI(state.x);
    updateDotsUI();
}

function adjustPlaceholder() {
    if (window.adjustPlaceholder) {
        window.adjustPlaceholder();
    }
}

function handleEndOfRound() {
    if (window.handleEndOfRound) {
        window.handleEndOfRound();
    }
}

function updateStatsUI(index) {
    const wrongEl = document.getElementById('wrong');
    const correctEl = document.getElementById('correct');
    if (wrongEl) wrongEl.textContent = state.sessionWrong;
    if (correctEl) correctEl.textContent = state.sessionCorrect;
    
    const scoreEl = document.getElementById('score-display');
    const progressEl = document.getElementById('progress-display');
    const rankEl = document.getElementById('rank-display');
    
    const completed = state.done.filter(Boolean).length;
    const total = state.done.length;
    
    if (scoreEl) scoreEl.textContent = state.score;
    
    if (progressEl && Array.isArray(state.done)) {
        const displayIndex = total - (state.questionQueue ? state.questionQueue.length : 0); 
        progressEl.innerHTML = `
            <div style="display: inline-flex; align-items: center; justify-content: center; position: relative; font-family: 'Outfit', sans-serif;">
                <span style="font-size: 1.25rem; font-weight: 800; color: var(--md-sys-color-primary); transform: translateY(-3px); line-height: 1;">${displayIndex}</span>
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
    const starBtn = document.getElementById('starToggle');
    if (!starBtn) return;
    const idx = (viewingIndex !== -1) ? viewingIndex : state.x;
    const isStarred = (idx !== -1 && state.unitStars && state.unitStars[idx]);
    if (isStarred) {
        starBtn.classList.add('active');
        starBtn.textContent = '★';
    } else {
        starBtn.classList.remove('active');
        starBtn.textContent = '☆';
    }
}

function createProgressDots() {
    const container = document.getElementById('fcProgressDots');
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
    const container = document.getElementById('fcProgressDots');
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

function goBackToCurrentProgress() {
    viewQuestion(state.x);
}

function updateUiAfterIAmRight() {
    setTimeout(() => {
        const idx = (viewingIndex !== -1) ? viewingIndex : state.x;
        updateDotsUI();
        updateStatsUI(idx);
    }, 100);
}

function viewQuestion(index) {
    viewingIndex = index;
    const q = state.data[index];
    if (!q) return;

    updateStatsUI(index);
    updateImageForIndex(index);

    const isConfirmed = state.done[index];
    const backBtn = document.getElementById('fcBackProgressBtn');
    const backBtnExpl = document.getElementById('fcBackProgressBtnExpl');
    const dontKnowBtn = document.getElementById('dontKnow');
    const submitBtn = document.getElementById('submitAnswer');
    const answerInputEl = document.getElementById('answer');

    if (answerInputEl) {
        answerInputEl.disabled = isConfirmed;
        answerInputEl.value = "";
    }

    const nextBtn = document.getElementById('next');

    if (index === state.x) {
        if (backBtn) backBtn.style.display = 'none';
        if (backBtnExpl) backBtnExpl.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'block';
        if (dontKnowBtn) dontKnowBtn.style.display = isConfirmed ? 'none' : 'block';
        if (submitBtn) submitBtn.style.display = isConfirmed ? 'none' : 'block';
        
        state.viewing = isConfirmed;

        if (isConfirmed) {
            document.querySelector('.answer-input-container').style.visibility = 'hidden';
            document.querySelector('.bottom-buttons').style.visibility = 'hidden';
            cardAnswerOverlay.style.display = "flex";
            restoreAnswerUIForIndex(index);
        } else {
            document.querySelector('.answer-input-container').style.visibility = 'visible';
            document.querySelector('.bottom-buttons').style.visibility = 'visible';
            cardAnswerOverlay.style.display = 'none';
            if (answerInputEl) {
                answerInputEl.focus();
                const desc = q.description;
                if (desc && desc.trim() !== "") {
                    answerInputEl.placeholder = desc;
                } else {
                    adjustPlaceholder();
                }
            }
        }
    } else {
        if (backBtn) backBtn.style.display = 'none';
        if (backBtnExpl) backBtnExpl.style.display = 'block';
        if (nextBtn) nextBtn.style.display = 'none';
        if (dontKnowBtn) dontKnowBtn.style.display = 'none';
        if (submitBtn) submitBtn.style.display = 'none';

        state.viewing = true;
        document.querySelector('.answer-input-container').style.visibility = 'hidden';
        document.querySelector('.bottom-buttons').style.visibility = 'hidden';
        cardAnswerOverlay.style.display = "flex";
        restoreAnswerUIForIndex(index);
    }

    updateDotsUI();
    updateStarsUI();

    if (window.updateCommentCount) window.updateCommentCount();
    if (window.updateQuestionStatsAndProgress) window.updateQuestionStatsAndProgress();
}

function restoreAnswerUIForIndex(index) {
    if (!state.data || index === undefined || !state.data[index]) return;

    const primaryAns = state.data[index].answer;
    const isCorrect = state.correctList.some(q => isSameQuestion(q, state.data[index]));
    const showAnsDiv = document.getElementById("showAnswer");
    
    if (showAnsDiv) {
        if (isCorrect) {
            showAnsDiv.innerHTML = primaryAns.map(ans => `<span style="color: var(--accent-green);">${ans}</span>`).join(' / ') + getAccuracyBadge();
        } else {
            const isInWrongList = state.wrongList.some(q => isSameQuestion(q, state.data[index]));
            if (isInWrongList) {
                showAnsDiv.innerHTML = `<span style="color: var(--accent-red);">${primaryAns.join(' / ')}</span>` + getAccuracyBadge();
            } else {
                showAnsDiv.innerHTML = primaryAns.join(' / ') + getAccuracyBadge();
            }
        }
        if (primaryAns && primaryAns.length > 0) {
            addOrUpdateSpeakButton(primaryAns[0], showAnsDiv);
        }
        updateAccuracyBadgeForIndex(index, showAnsDiv, primaryAns);
    }
    showExplanationForIndex(index);
}

function showExplanationForIndex(index) {
    const expDiv = document.getElementById("showExplanation");
    if (!expDiv) return;
    expDiv.innerHTML = '';
    const explanationText = state.data[index]?.explanation?.trim();
    const hasExplanation = explanationText && explanationText !== "\"\"";

    if (hasExplanation) {
        expDiv.innerHTML = `${explanationText.replace(/<script.*?>.*?<\/script>/gi, '')}`;
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
    if (correctEl) correctEl.innerText = state.sessionCorrect;
    if (wrongEl) wrongEl.innerText = state.sessionWrong;

    const errorNum = state.data[index]?.num;
    const numBadge = document.getElementById("explanation-num-badge");
    if (numBadge) {
        numBadge.textContent = errorNum ? `${errorNum}` : "";
        numBadge.style.display = errorNum ? "block" : "none";
    }

    if (iAmRightBtn) {
        const currentQuestion = state.data[index];
        const isInWrongList = currentQuestion && state.wrongList.some(item => isSameQuestion(item, currentQuestion));
        iAmRightBtn.style.display = isInWrongList ? "block" : "none";
    }

    expDiv.style.display = "block";
}

function updateImageForIndex(index) {
    loadingScreen.style.display = 'flex';
    imageElement.classList.remove('loaded');
    imageElement.src = "";

    if (index === -1 || state.data[index] === undefined) {
        loadingScreen.style.display = 'none';
        return false;
    }

    let picref = resolveImagePath(state.data[index]);

    if (picref) {
        imageElement.setAttribute('src', picref);
        const altText = state.data[index]?.answer?.[0] || `Parasite image ${index + 1}`;
        imageElement.setAttribute('alt', `Image for: ${altText}`);
    } else {
        imageElement.alt = "Image not available";
        loadingScreen.style.display = 'none';
    }
}

async function updateAccuracyBadgeForIndex(index, showAnsDiv, primaryAns) {
    const path = getQuestionStatsPath(index);
    if (!path) return;

    let correctCount = 0;
    let totalCount = 0;

    try {
        const statsRef = ref(db, path);
        const snapshot = await get(statsRef);
        if (snapshot.exists()) {
            const val = snapshot.val();
            correctCount = val.correctCount || 0;
            totalCount = val.totalCount || 0;
        }
    } catch (e) {
        console.error(e);
    }

    let percentText = "N/A";
    if (totalCount > 0) {
        percentText = Math.round((correctCount / totalCount) * 100) + "%";
    }

    const badge = showAnsDiv.querySelector('.accuracy-badge');
    if (badge) {
        if (percentText === "N/A") {
            badge.remove();
        } else {
            badge.textContent = `答對率 ${percentText}`;
        }
    } else {
        if (percentText !== "N/A") {
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
