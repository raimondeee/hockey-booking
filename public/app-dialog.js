(function (global) {
    let dialogQueue = Promise.resolve();

    function enqueue(task) {
        const run = dialogQueue.then(() => task());
        dialogQueue = run.catch(() => {});
        return run;
    }

    function ensureDialogDom() {
        if (document.getElementById('app-dialog-overlay')) return;

        const style = document.createElement('style');
        style.id = 'app-dialog-styles';
        style.textContent = `
            #app-dialog-overlay {
                display: none;
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.55);
                z-index: 3000;
                align-items: center;
                justify-content: center;
                padding: 20px;
                box-sizing: border-box;
            }
            #app-dialog-overlay.is-open {
                display: flex;
            }
            #app-dialog-panel {
                width: 100%;
                max-width: 420px;
                background: #fff;
                color: #333;
                border-radius: 10px;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.28);
                padding: 22px 22px 18px;
                box-sizing: border-box;
                animation: app-dialog-in 0.18s ease-out;
            }
            @keyframes app-dialog-in {
                from { opacity: 0; transform: scale(0.96) translateY(8px); }
                to { opacity: 1; transform: scale(1) translateY(0); }
            }
            #app-dialog-message {
                margin: 0 0 18px 0;
                font-size: 15px;
                line-height: 1.5;
                white-space: pre-wrap;
                word-break: break-word;
            }
            #app-dialog-actions {
                display: flex;
                justify-content: flex-end;
                gap: 10px;
            }
            .app-dialog-btn {
                border: none;
                border-radius: 6px;
                padding: 10px 16px;
                font-size: 14px;
                font-weight: 600;
                cursor: pointer;
            }
            .app-dialog-btn-primary {
                background: #0070ba;
                color: #fff;
            }
            .app-dialog-btn-primary:hover { background: #005fa3; }
            .app-dialog-btn-secondary {
                background: #e9ecef;
                color: #333;
            }
            .app-dialog-btn-secondary:hover { background: #dde2e6; }
        `;
        document.head.appendChild(style);

        const overlay = document.createElement('div');
        overlay.id = 'app-dialog-overlay';
        overlay.setAttribute('role', 'presentation');
        overlay.innerHTML = `
            <div id="app-dialog-panel" role="dialog" aria-modal="true" aria-labelledby="app-dialog-message">
                <p id="app-dialog-message"></p>
                <div id="app-dialog-actions">
                    <button type="button" class="app-dialog-btn app-dialog-btn-secondary" id="app-dialog-cancel" style="display:none;">Cancel</button>
                    <button type="button" class="app-dialog-btn app-dialog-btn-primary" id="app-dialog-ok">OK</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);
    }

    function showDialog(message, mode) {
        ensureDialogDom();

        return enqueue(() => new Promise((resolve) => {
            const overlay = document.getElementById('app-dialog-overlay');
            const messageEl = document.getElementById('app-dialog-message');
            const okBtn = document.getElementById('app-dialog-ok');
            const cancelBtn = document.getElementById('app-dialog-cancel');
            const isConfirm = mode === 'confirm';

            messageEl.textContent = message;
            cancelBtn.style.display = isConfirm ? 'inline-block' : 'none';
            okBtn.textContent = isConfirm ? 'Confirm' : 'OK';
            overlay.classList.add('is-open');

            function finish(value) {
                overlay.classList.remove('is-open');
                okBtn.removeEventListener('click', onOk);
                cancelBtn.removeEventListener('click', onCancel);
                document.removeEventListener('keydown', onKeydown);
                resolve(value);
            }

            function onOk() { finish(isConfirm ? true : undefined); }
            function onCancel() { finish(false); }
            function onKeydown(e) {
                if (e.key === 'Escape' && isConfirm) onCancel();
                if (e.key === 'Enter') onOk();
            }

            okBtn.addEventListener('click', onOk);
            cancelBtn.addEventListener('click', onCancel);
            document.addEventListener('keydown', onKeydown);
            okBtn.focus();
        }));
    }

    const AppDialog = {
        alert(message) {
            return showDialog(String(message ?? ''), 'alert');
        },
        confirm(message) {
            return showDialog(String(message ?? ''), 'confirm');
        }
    };

    global.AppDialog = AppDialog;
    global.alert = function appDialogAlert(message) {
        AppDialog.alert(message);
    };
})(typeof window !== 'undefined' ? window : global);
