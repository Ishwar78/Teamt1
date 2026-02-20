const activeWin = require('active-win');

async function getActiveWindow() {
    try {
        const win = await activeWin();
        let url = win?.url || '';
        const appName = win?.owner?.name || '';
        let title = win?.title || '';

        if (!url && ['Google Chrome', 'Microsoft Edge', 'Brave', 'Firefox', 'Opera'].includes(appName)) {
            if (title) {
                let cleanTitle = title;
                cleanTitle = cleanTitle.replace(/\s*-\s*Google Chrome$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Microsoft\u200b Edge$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Microsoft Edge$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Brave$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Mozilla Firefox$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Opera$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Profile \d+$/, '');
                cleanTitle = cleanTitle.replace(/\s*-\s*Personal$/, '');
                url = cleanTitle;
            }
        }

        return {
            title: title,
            app: appName,
            url: url
        };
    } catch {
        return { title: '', app: '', url: '' };
    }
}

(async () => {
    console.log(await getActiveWindow());
})();
