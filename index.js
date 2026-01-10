        //oz@microchip.cl 
        //@Emmet53279!
const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// VARIABLES GLOBALES
let globalBrowser = null;
let pestanaTrabajo = null;
let robotListo = false;
let robotOcupado = false;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO (CON ESCALA TÉCNICA EN HOME) ---
async function iniciarRobot() {
    console.log('--- VERSIÓN v5.7 (ESCALA TÉCNICA EN HOME) ---'); 
    console.log('🤖 INICIANDO ROBOT...');
    robotListo = false;

    try {
        if (globalBrowser) await globalBrowser.close();

        globalBrowser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--mute-audio',
                '--window-size=1280,720'
            ]
        });

        const pestanaLogin = await globalBrowser.newPage();
        
        // INTERCEPTOR 1: Login y Portal (Bloqueo agresivo)
        await pestanaLogin.setRequestInterception(true);
        pestanaLogin.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet', 'other'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        pestanaLogin.setDefaultNavigationTimeout(120000); 
        await pestanaLogin.setViewport({ width: 1280, height: 720 });

        console.log('   > 1. Autenticando...');
        try {
            await pestanaLogin.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {}

        await pestanaLogin.waitForSelector('input[formcontrolname="email"]', { timeout: 60000 });
        await pestanaLogin.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await pestanaLogin.type('input[formcontrolname="password"]', '@Emmet53279!'); 
        
        console.log('   > 2. Entrando al Portal...');
        await pestanaLogin.click('button.df-primario');

        // Esperamos el botón del ERP
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        try {
            await pestanaLogin.waitForXPath(erpButtonSelector, { visible: true, timeout: 60000 });
        } catch (error) {
            throw new Error("No cargó el Portal (Memoria o Timeout).");
        }
        
        const [erpButton] = await pestanaLogin.$x(erpButtonSelector);
        
        // Preparamos la captura de la pestaña HOME
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === pestanaLogin.target());
        
        console.log('   > 3. Clic en ERP... Abriendo HOME...');
        await erpButton.click();
        
        const newTarget = await newTargetPromise;
        const nuevaPestana = await newTarget.page(); 

        if (!nuevaPestana) throw new Error("No se abrió la pestaña del ERP");

        // --- GESTIÓN DE LA NUEVA PESTAÑA (HOME) ---
        pestanaTrabajo = nuevaPestana;

        // ¡IMPORTANTE! Activamos el bloqueo en la nueva pestaña inmediatamente para que el Dashboard no consuma RAM
        await pestanaTrabajo.setRequestInterception(true);
        pestanaTrabajo.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet', 'other'].includes(req.resourceType())) {
                req.abort(); // Bloqueamos los gráficos del Dashboard
            } else {
                req.continue();
            }
        });

        // Cerramos login para ahorrar
        await pestanaLogin.close();

        pestanaTrabajo.setDefaultNavigationTimeout(120000);
        await pestanaTrabajo.setViewport({ width: 1280, height: 720 });

        // AQUÍ ESTÁ EL CAMBIO QUE PEDISTE:
        console.log('   > 4. Marcando presencia en HOME (10s)...');
        // Dejamos que la URL https://erp.defontana.com/#/Home cargue sus scripts básicos
        // y valide el token, pero sin cargar imágenes gracias al interceptor.
        await new Promise(r => setTimeout(r, 10000));

        console.log('   > 5. Token validado. Saltando a Maestro-UX...');
        await pestanaTrabajo.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'domcontentloaded' });

        console.log('   > 6. Esperando buscador...');
        await pestanaTrabajo.waitForSelector('input[formcontrolname="searchInputText"]', { timeout: 60000 });
        
        try {
            await pestanaTrabajo.waitForSelector('tr.mat-row', { timeout: 20000 });
            console.log('   > Tabla inicial detectada.');
        } catch(e) { console.log('   > Tabla vacía o cargando...'); }

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO');
        robotListo = true;

    } catch (error) {
        console.error('❌ Error iniciando:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

iniciarRobot();

// Ping
app.get('/ping', (req, res) => res.send('pong'));

// --- ENDPOINT CONSULTA ---
app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;
    if (!skuBuscado) return res.status(400).json({ error: 'Falta SKU' });
    
    if (!robotListo || !pestanaTrabajo) {
        iniciarRobot(); 
        return res.status(503).json({ error: 'Reiniciando sistema...' });
    }

    if (robotOcupado) return res.status(429).json({ error: 'Ocupado.' });

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando Detalle: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';

        // 1. Limpieza y Escritura
        await pestanaTrabajo.evaluate((sel) => {
            const el = document.querySelector(sel);
            if(el) el.focus();
            el.value = '';
        }, selectorInput);
        
        await pestanaTrabajo.type(selectorInput, skuLimpio, { delay: 50 });
        await new Promise(r => setTimeout(r, 200));
        await pestanaTrabajo.keyboard.press('Enter');
        
        await new Promise(r => setTimeout(r, 4000));

        // 2. Buscar fila y abrir menú
        const datosGenerales = await pestanaTrabajo.evaluate(async (sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');
                    const botonMenu = fila.querySelector('.mat-menu-trigger');
                    
                    if (botonMenu) {
                        botonMenu.click(); 
                        return { 
                            found: true, 
                            desc: celdaDesc ? celdaDesc.innerText.trim() : '',
                            precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                        };
                    }
                }
            }
            return { found: false };
        }, skuLimpio);

        if (!datosGenerales.found) {
            robotOcupado = false;
            return res.json({ status: 'ok', mensaje: 'No encontrado', data: { codigo: skuLimpio, stockTotal: 0 } });
        }

        // 3. Clic en Stock por Bodega
        try {
            const xpathOpcion = "//span[contains(text(), 'Stock por bodega')]";
            await pestanaTrabajo.waitForXPath(xpathOpcion, { visible: true, timeout: 5000 });
            const [opcionBtn] = await pestanaTrabajo.$x(xpathOpcion);
            await opcionBtn.click();
        } catch (e) {
            throw new Error("Menú no desplegó opción");
        }

        // 4. Leer Popup
        await pestanaTrabajo.waitForSelector('.stock-article-storage-dialog', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 1000));

        const bodegas = await pestanaTrabajo.evaluate(() => {
            const filas = document.querySelectorAll('.stock-article-storage-dialog tr.mat-row');
            let central = 0;
            let ventas = 0;

            filas.forEach(fila => {
                const celdaNombre = fila.querySelector('.mat-column-nameStorage');
                const celdaStock = fila.querySelector('.mat-column-stockStorage');
                
                if (celdaNombre && celdaStock) {
                    const nombre = celdaNombre.innerText.trim();
                    let stockTexto = celdaStock.innerText.trim();
                    let stockNum = (stockTexto === 'Sin Stock') ? 0 : parseInt(stockTexto, 10);
                    if (isNaN(stockNum)) stockNum = 0;

                    if (nombre.includes('Bodega_Central_962')) central = stockNum;
                    else if (nombre.includes('Sala_Ventas_962')) ventas = stockNum;
                }
            });
            return { central, ventas };
        });

        // 5. Cerrar Popup
        await pestanaTrabajo.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500));

        robotOcupado = false;
        
        const respuestaFinal = {
            codigo: skuLimpio,
            descripcion: datosGenerales.desc,
            precio: datosGenerales.precio,
            stockCentral: bodegas.central,
            stockVentas: bodegas.ventas,
            stockTotal: bodegas.central + bodegas.ventas
        };

        console.log('   > Éxito:', respuestaFinal.codigo);
        res.json({ status: 'ok', mensaje: 'Encontrado', data: respuestaFinal });

    } catch (error) {
        console.error('Error búsqueda:', error);
        robotOcupado = false;
        try { await pestanaTrabajo.keyboard.press('Escape'); } catch(e) {}
        
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            robotListo = false;
        }
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    }
});

// Latido
setInterval(async () => {
    if (robotListo && pestanaTrabajo && !robotOcupado) {
        console.log('💓 Heartbeat...');
        try {
            await pestanaTrabajo.evaluate(() => {
                window.scrollBy(0, 10);
                setTimeout(() => window.scrollBy(0, -10), 100);
            });
        } catch(e) { robotListo = false; }
    }
}, 48000);

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
