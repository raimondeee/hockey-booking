(function () {
    function dismissStorageKey(message) {
        let hash = 0;
        const text = message || '';
        for (let i = 0; i < text.length; i++) {
            hash = ((hash << 5) - hash) + text.charCodeAt(i);
            hash |= 0;
        }
        return 'site_banner_dismissed_' + hash;
    }

    function ensureBannerStyles() {
        if (document.getElementById('site-notice-banner-styles')) return;
        const style = document.createElement('style');
        style.id = 'site-notice-banner-styles';
        style.textContent = `
            .site-notice-banner {
                display: none;
                align-items: flex-start;
                justify-content: space-between;
                gap: 12px;
                padding: 12px 16px;
                margin: 0 auto 16px;
                max-width: 960px;
                width: 95%;
                box-sizing: border-box;
                background: #fff3cd;
                border: 1px solid #ffc107;
                border-radius: 8px;
                color: #856404;
                font-size: 14px;
                line-height: 1.45;
                box-shadow: 0 2px 8px rgba(0,0,0,0.06);
            }
            .site-notice-banner.visible { display: flex; }
            .site-notice-banner.dark-theme {
                background: rgba(255, 193, 7, 0.12);
                border-color: #ffc107;
                color: #f6e05e;
                max-width: none;
                width: auto;
                margin: 0 50px 20px;
            }
            .site-notice-banner-text { flex: 1; }
            .site-notice-banner-actions { display: flex; flex-shrink: 0; gap: 8px; align-items: flex-start; }
            .site-notice-dismiss-btn {
                background: #856404;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: bold;
                cursor: pointer;
                white-space: nowrap;
            }
            .site-notice-dismiss-btn:hover { background: #6d5204; }
            @media (max-width: 600px) {
                .site-notice-banner { flex-direction: column; }
                .site-notice-banner.dark-theme { margin: 0 16px 16px; }
            }
        `;
        document.head.appendChild(style);
    }

    window.SiteBanner = {
        config: null,
        mountId: 'siteNoticeBannerMount',

        async load(options = {}) {
            ensureBannerStyles();
            try {
                const res = await fetch('/api/config/site');
                this.config = await res.json();
            } catch (err) {
                console.warn('Site banner config unavailable:', err);
                return;
            }
            this.render(options);
        },

        render(options = {}) {
            const cfg = this.config;
            if (!cfg || !cfg.banner_enabled || !cfg.banner_message) {
                this.hide();
                return;
            }

            const dismissKey = dismissStorageKey(cfg.banner_message);
            if (sessionStorage.getItem(dismissKey) === '1') {
                this.hide();
                return;
            }

            let mount = document.getElementById(this.mountId);
            if (!mount) {
                mount = document.createElement('div');
                mount.id = this.mountId;
                const anchor = options.insertBefore || document.body.firstChild;
                if (anchor && anchor.parentNode) {
                    anchor.parentNode.insertBefore(mount, anchor);
                } else {
                    document.body.prepend(mount);
                }
            }

            const darkClass = options.darkTheme ? ' dark-theme' : '';
            mount.innerHTML = `
                <div class="site-notice-banner visible${darkClass}" role="status" aria-live="polite">
                    <div class="site-notice-banner-text">${this.escapeHtml(cfg.banner_message)}</div>
                    <div class="site-notice-banner-actions">
                        <button type="button" class="site-notice-dismiss-btn" onclick="SiteBanner.dismiss()">Got it</button>
                    </div>
                </div>
            `;
        },

        dismiss() {
            if (this.config && this.config.banner_message) {
                sessionStorage.setItem(dismissStorageKey(this.config.banner_message), '1');
            }
            this.hide();
        },

        hide() {
            const mount = document.getElementById(this.mountId);
            if (mount) mount.innerHTML = '';
        },

        escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }
    };
})();
