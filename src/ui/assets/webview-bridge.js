(function () {
	const vscode = acquireVsCodeApi();
	function getModelRowStep(list) {
		const template = getComputedStyle(list).gridTemplateColumns;
		const columns = Math.max(1, template.split(" ").filter(Boolean).length);
		return columns * 2;
	}
	function revealModelRows(button, count) {
		const list = button.previousElementSibling;
		if (!list) return;
		const step = count || getModelRowStep(list);
		const hidden = Array.from(
			list.querySelectorAll("[data-model-extra='true'][style*='display:none']"),
		).slice(0, step);
		hidden.forEach(function (element) {
			element.style.display = "";
		});
		const remaining = list.querySelectorAll(
			"[data-model-extra='true'][style*='display:none']",
		).length;
		if (remaining === 0) button.remove();
		else button.textContent = "Show more";
	}
	function initializeModelSpend() {
		document.querySelectorAll(".or-model-show-more").forEach(function (button) {
			revealModelRows(button, getModelRowStep(button.previousElementSibling));
		});
	}
	function setCommandPending(element, pending) {
		if (!(element instanceof HTMLElement)) return;
		const preservesContent = element.classList.contains("or-key-card-main");
		if (pending) {
			if (!preservesContent && !element.dataset.idleLabel) {
				element.dataset.idleLabel = element.textContent || "";
			}
			element.disabled = true;
			element.setAttribute("aria-busy", "true");
			element.classList.add("or-command-pending");
			if (!preservesContent) element.textContent = "Working…";
		} else {
			element.disabled = false;
			element.removeAttribute("aria-busy");
			element.classList.remove("or-command-pending");
			if (!preservesContent && element.dataset.idleLabel) {
				element.textContent = element.dataset.idleLabel;
			}
		}
	}
	function setLiveText(prefix, message) {
		const live = document.getElementById("or-live-region");
		if (live) live.textContent = prefix + (message || "");
	}
	function handleLoadingProgress(message) {
		if (typeof message.progressText !== "string") return false;
		const progressElement = document.querySelector(".or-center p");
		if (progressElement) {
			progressElement.textContent = message.progressText;
		}
		setLiveText("Loading progress: ", message.progressText);
		return true;
	}
	function findRequestElement(requestId) {
		const elements = document.querySelectorAll("[data-request-id]");
		return Array.from(elements).find(function (element) {
			return element.dataset.requestId === requestId;
		});
	}
	function handleUpdateHtml(message) {
		if (typeof message.html !== "string") return false;
		const root = document.querySelector(".or-root");
		if (!root) return true;
		const active = document.activeElement;
		const activeKey = active?.closest?.("[data-key-focus]")?.dataset.keyFocus;
		const activeModel = active?.closest?.("[data-model-id]")?.dataset.modelId;
		const revealedModels = Array.from(root.querySelectorAll("[data-model-extra='true']"))
			.filter(function (element) {
				return element.style.display !== "none";
			})
			.map(function (element) {
				return element.dataset.modelId;
			});
		root.innerHTML = message.html;
		revealedModels.forEach(function (modelId) {
			const row = root.querySelector('[data-model-id="' + modelId + '"]');
			if (row) row.style.display = "";
		});
		initializeModelSpend();
		let focusTarget = null;
		if (activeKey) focusTarget = root.querySelector('[data-key-focus="' + activeKey + '"]');
		else if (activeModel) focusTarget = root.querySelector('[data-model-id="' + activeModel + '"]');
		if (focusTarget instanceof HTMLElement) focusTarget.focus();
		setLiveText("Dashboard updated. ", message.liveText);
		return true;
	}
	function handleCommandMessage(message) {
		if (!message.requestId) return false;
		const element = findRequestElement(message.requestId);
		if (message.cmd === "commandPending") {
			setCommandPending(element, true);
			return true;
		}
		if (message.cmd === "commandResult") {
			setCommandPending(element, false);
			setLiveText(message.ok ? "Action completed. " : "Action failed. ", message.liveText);
			return true;
		}
		return false;
	}
	function handleSwitchKey(message) {
		if (!message.hash) return;
		document.querySelectorAll(".or-key-card").forEach(function (card) {
			const selected = card.dataset.keyHash === message.hash;
			card.classList.toggle("or-key-card--selected", selected);
			const button = card.querySelector(".or-key-card-main");
			if (button) {
				button.setAttribute("aria-pressed", selected ? "true" : "false");
				button.setAttribute("tabindex", selected ? "0" : "-1");
			}
		});
		document.querySelectorAll(".or-key-detail").forEach(function (card) {
			card.style.display = card.dataset.keyHash === message.hash ? "" : "none";
		});
	}
	function moveKeyFocus(button, offset, targetIndex) {
		const buttons = Array.from(document.querySelectorAll("[data-key-focus]"));
		const index = buttons.indexOf(button);
		if (index < 0 || buttons.length === 0) return;
		const nextIndex =
			typeof targetIndex === "number"
				? targetIndex
				: (index + offset + buttons.length) % buttons.length;
		buttons.forEach(function (item, itemIndex) {
			item.setAttribute("tabindex", itemIndex === nextIndex ? "0" : "-1");
		});
		buttons[nextIndex].focus();
	}
	const state = vscode.getState();
	if (state && typeof state.scrollY === "number") {
		requestAnimationFrame(function () {
			window.scrollTo(0, state.scrollY);
		});
	}
	initializeModelSpend();
	vscode.postMessage({ cmd: "dashboardReady" });
	document.addEventListener("click", function (event) {
		const targetElement = event.target instanceof Element ? event.target : null;
		const reveal = targetElement?.closest("[data-reveal-model-rows]");
		if (reveal) {
			event.preventDefault();
			revealModelRows(reveal);
			return;
		}
		const target = targetElement?.closest("[data-cmd]");
		if (!target) return;
		if (target instanceof HTMLAnchorElement && target.target === "_blank") return;
		event.preventDefault();
		if (target instanceof HTMLButtonElement && target.disabled) return;
		const requestId = target.dataset.requestId || target.dataset.cmd + "-" + Date.now();
		target.dataset.requestId = requestId;
		setCommandPending(target, true);
		vscode.setState({ scrollY: window.scrollY });
		vscode.postMessage({
			cmd: target.dataset.cmd,
			requestId: requestId,
			hash: target.dataset.hash || null,
			alertId: target.dataset.alertId || null,
			wsId: target.dataset.wsId || null,
			wsSlug: target.dataset.wsSlug || null,
			interval: target.dataset.interval || null,
		});
	});
	document.addEventListener("keydown", function (event) {
		const target =
			event.target instanceof Element ? event.target.closest("[data-key-focus]") : null;
		if (!target) return;
		if (event.key === "ArrowDown" || event.key === "ArrowRight") {
			event.preventDefault();
			moveKeyFocus(target, 1);
		} else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
			event.preventDefault();
			moveKeyFocus(target, -1);
		} else if (event.key === "Home") {
			event.preventDefault();
			moveKeyFocus(target, 0, 0);
		} else if (event.key === "End") {
			event.preventDefault();
			moveKeyFocus(target, 0, document.querySelectorAll("[data-key-focus]").length - 1);
		} else if (event.key === "Enter" || event.key === " ") {
			event.preventDefault();
			target.click();
		}
	});
	window.addEventListener("message", function (event) {
		if (event.origin !== window.origin && event.origin !== "null") return;
		const message = event.data;
		if (message?.cmd === "updateHtml") {
			handleUpdateHtml(message);
			return;
		}
		if (message?.cmd === "commandPending" || message?.cmd === "commandResult") {
			handleCommandMessage(message);
			return;
		}
		if (message?.cmd === "loadingProgress") {
			handleLoadingProgress(message);
			return;
		}
		if (message?.cmd === "switchKey") handleSwitchKey(message);
	});
})();
