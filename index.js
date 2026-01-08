const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// VARIABLES GLOBALES (El estado del Robot)
let globalBrowser = null;
let targetFrame = null; // Aquí guardaremos el iframe listo para buscar
let erpPage = null;     // La página principal
let robotOcupado = false; // Semáforo para que no se crucen búsquedas

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO (ARRANCA EL MOTOR) ---
async function iniciarRobot() {
    console.log('🤖 INICIANDO ROBOT (Login y Preparación)...');
    try {
        if (globalBrowser) await globalBrowser.close();

        globalBrowser = await puppeteer.launch({
            headless: true, // Modo servidor
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--window-size=1920,1080'
            ]
        });

        const page = await globalBrowser.newPage();
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });

        // 1. LOGIN
        console.log('   > Entrando al login...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('input[formcontrolname="email"]');
         // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);

        // 2. ABRIR ERP
        console.log('   > Abriendo ERP...');
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        await erpButton.click();
        await new Promise(r => setTimeout(r, 5000)); // Esperar nueva pestaña

        // 3. CAPTURAR PESTAÑA
        const pages = await globalBrowser.pages();
        erpPage = pages[pages.length - 1]; // Guardamos en variable global
        
        if (!erpPage) throw new Error("No se detectó pestaña ERP");
        
        // Configuraciones globales
        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('   > Esperando carga inicial (12s)...');
        await new Promise(r => setTimeout(r, 12000));

        // 4. NAVEGAR A INVENTARIO
        console.log('   > Navegando al menú...');
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        try {
            await erpPage.waitForXPath(xpathInventario, { visible: true, timeout: 5000 });
            const [btnInv] = await erpPage.$x(xpathInventario);
            await erpPage.evaluate(el => el.click(), btnInv);
            await new Promise(r => setTimeout(r, 1000));
        } catch(e) { console.log('   (Menú quizás ya abierto)'); }

        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos, { visible: true });
        const [btnArt] = await erpPage.$x(xpathArticulos);
        await erpPage.evaluate(el => el.click(), btnArt);

        console.log('   > Cargando módulo Artículos (10s)...');
        await new Promise(r => setTimeout(r, 10000));

        // 5. LOCALIZAR EL IFRAME (Una sola vez)
        console.log('   > Localizando iframe de búsqueda...');
        const allFrames = erpPage.frames();
        targetFrame = null;

        for (const frame of allFrames) {
            const existe = await frame.$('input[formcontrolname="searchInputText"]');
            if (existe) {
                targetFrame = frame;
                console.log(`✅ ROBOT LISTO EN: ${frame.url()}`);
                break;
            }
        }

        if (!targetFrame) {
            // Backup search
            for (const frame of allFrames) {
                if (await frame.$('input[placeholder*="escripción"]')) {
                    targetFrame = frame;
                    console.log(`✅ ROBOT LISTO (Backup) EN: ${frame.url()}`);
                    break;
                }
            }
        }

        if (!targetFrame) throw new Error("No se encontró el iframe de búsqueda");

        // Robot listo para recibir órdenes
        return true;

    } catch (error) {
        console.error('❌ Error iniciando robot:', error);
        if (globalBrowser) await globalBrowser.close();
        globalBrowser = null;
        targetFrame = null;
        return false;
    }
}

// INICIAR AL ARRANCAR EL SERVIDOR
iniciarRobot();

// --- ENDPOINT DE CONSULTA RÁPIDA ---
app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;
    if (!skuBuscado) return res.status(400).json({ error: 'Falta SKU' });
    
    // Verificamos si el robot está vivo
    if (!globalBrowser || !targetFrame) {
        // Intentamos revivirlo
        const revivido = await iniciarRobot();
        if (!revivido) {
            return res.status(503).json({ error: 'El sistema se está reiniciando, intenta en 1 minuto.' });
        }
    }

    // Evitar conflictos si dos personas buscan a la vez
    if (robotOcupado) {
        return res.status(429).json({ error: 'Sistema ocupado, intenta en 2 segundos.' });
    }

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Búsqueda Rápida: ${skuLimpio}`);

    try {
        // Selector guardado
        const selector = 'input[formcontrolname="searchInputText"]'; 
        // Si fallara, habría que re-detectar, pero asumimos que el iframe no cambia ID
        
        // 1. Limpieza y Escritura (MÉTODO ULTRA RÁPIDO)
        await targetFrame.click(selector, { clickCount: 3 });
        await new Promise(r => setTimeout(r, 100)); // Pequeña pausa
        await erpPage.keyboard.press('Backspace');
        
        await targetFrame.type(selector, skuLimpio, { delay: 50 }); // Escribimos más rápido ahora
        await erpPage.keyboard.press('Enter');

        // 2. Esperar Resultados (Tiempo corto porque ya está cargado)
        try {
            await targetFrame.waitForSelector('.mat-column-id', { timeout: 5000 });
        } catch(e) { /* Si no aparece, asumimos vacío */ }

        // 3. Extracción
        const resultado = await targetFrame.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo.includes(sku)) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');
                    return {
                        found: true,
                        data: {
                            codigo: textoCodigo,
                            descripcion: celdaDesc ? celdaDesc.innerText.trim() : '',
                            stock: celdaStock ? celdaStock.innerText.trim() : '0',
                            precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                        }
                    };
                }
            }
            return { found: false };
        }, skuLimpio);

        robotOcupado = false;

        if (resultado.found) {
            res.json({ status: 'ok', mensaje: 'Encontrado', data: resultado.data });
        } else {
            res.json({ status: 'ok', mensaje: 'No encontrado', data: { codigo: skuLimpio, stock: '0', precio: '-' } });
        }

    } catch (error) {
        console.error('Error en búsqueda rápida:', error);
        robotOcupado = false;
        
        // Si hay error crítico (ej: navegador cerrado), reseteamos variables para que se reinicie en la prox
        if (error.message.includes('Session closed') || error.message.includes('Target closed')) {
            targetFrame = null;
            globalBrowser = null;
        }
        res.status(500).json({ error: 'Error de conexión', detalle: error.message });
    }
});

// --- MANTENER VIVO EL SISTEMA (Ping cada 5 min) ---
setInterval(async () => {
    if (targetFrame && erpPage) {
        console.log('💓 Heartbeat: Manteniendo sesión activa...');
        try {
            // Hacemos un click "fantasma" en el título para que no nos desconecte por inactividad
            await erpPage.click('body');
        } catch (e) {
            console.log('⚠️ Sesión perdida, se reiniciará en la próxima consulta.');
            targetFrame = null;
        }
    }
}, 300000); // 5 minutos

app.listen(port, () => {
    console.log(`🚀 Servidor Ultra-Rápido listo en puerto ${port}`);
});
