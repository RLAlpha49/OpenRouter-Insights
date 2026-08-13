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
		button.setAttribute("aria-expanded", hidden.length > 0 ? "true" : "false");
		const controlledList = button.getAttribute("aria-controls");
		if (!controlledList) return;
		if (remaining === 0) {
			const focusTarget = hidden[0] || list;
			button.remove();
			if (focusTarget instanceof HTMLElement) {
				if (!focusTarget.hasAttribute("tabindex")) focusTarget.setAttribute("tabindex", "-1");
				focusTarget.focus();
			}
		} else {
			button.setAttribute(
				"aria-label",
				"Show " + remaining + " more model" + (remaining === 1 ? "" : "s"),
			);
			button.textContent = "Show more";
		}
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
	function captureInteractionState(root) {
		const active = document.activeElement;
		const controls = Array.from(root.querySelectorAll("input, select, textarea")).map(
			function (control) {
				return {
					id: control.id,
					name: control.name,
					tagName: control.tagName,
					value: control.value,
					checked: typeof control.checked === "boolean" ? control.checked : undefined,
				};
			},
		);
		return {
			scrollY: window.scrollY,
			activeFocusId: active?.closest?.("[data-focus-id]")?.dataset.focusId,
			activeKey: active?.closest?.("[data-key-focus]")?.dataset.keyFocus,
			activeModel: active?.closest?.("[data-model-id]")?.dataset.modelId,
			revealedModels: Array.from(root.querySelectorAll("[data-model-extra='true']"))
				.filter(function (element) {
					return element.style.display !== "none";
				})
				.map(function (element) {
					return element.dataset.modelId;
				}),
			controls: controls,
		};
	}
	function findControl(root, state) {
		const controls = Array.from(root.querySelectorAll("input, select, textarea"));
		return (
			controls.find(function (control) {
				return state.id && control.id === state.id;
			}) ||
			controls.find(function (control) {
				return (
					state.name &&
					control.name === state.name &&
					control.tagName === state.tagName &&
					control.value === state.value
				);
			})
		);
	}
	function restoreInteractionState(root, state) {
		if (!state) return;
		(state.controls || []).forEach(function (controlState) {
			const control = findControl(root, controlState);
			if (!control) return;
			if (typeof controlState.checked === "boolean") control.checked = controlState.checked;
			if (typeof controlState.value === "string" && control.tagName !== "INPUT")
				control.value = controlState.value;
		});
		(state.revealedModels || []).forEach(function (modelId) {
			const row = Array.from(root.querySelectorAll("[data-model-id]")).find(function (element) {
				return element.dataset.modelId === modelId;
			});
			if (row) row.style.display = "";
		});
		initializeModelSpend();
		let focusTarget = null;
		if (state.activeFocusId) {
			focusTarget = Array.from(root.querySelectorAll("[data-focus-id]")).find(function (element) {
				return element.dataset.focusId === state.activeFocusId;
			});
		} else if (state.activeKey) {
			focusTarget = Array.from(root.querySelectorAll("[data-key-focus]")).find(function (element) {
				return element.dataset.keyFocus === state.activeKey;
			});
		} else if (state.activeModel) {
			focusTarget = Array.from(root.querySelectorAll("[data-model-id]")).find(function (element) {
				return element.dataset.modelId === state.activeModel;
			});
		}
		if (focusTarget instanceof HTMLElement) focusTarget.focus();
		if (typeof state.scrollY === "number") window.scrollTo(0, state.scrollY);
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
		const interactionState = captureInteractionState(root);
		root.innerHTML = message.html;
		restoreInteractionState(root, interactionState);
		setLiveText("Dashboard updated. ", message.liveText);
		return true;
	}
	function handleUpdateRegion(message) {
		if (typeof message.region !== "string" || !/^[a-z][a-z0-9-]*$/.test(message.region))
			return false;
		if (typeof message.html !== "string") return false;
		const root = document.querySelector(".or-root");
		if (!root) return true;
		const target = Array.from(root.querySelectorAll("[data-region]")).find(function (element) {
			return element.dataset.region === message.region;
		});
		if (!target) return true;
		const interactionState = captureInteractionState(root);
		target.innerHTML = message.html;
		restoreInteractionState(root, interactionState);
		setLiveText("Dashboard section updated. ", message.liveText);
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
		if (message?.cmd === "updateRegion") {
			handleUpdateRegion(message);
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
