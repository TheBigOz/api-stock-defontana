        //oz@microchip.cl 
        //@Emmet5264305!
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

// --- FUNCIÓN DE INICIO (A PRUEBA DE LENTITUD) ---
async function iniciarRobot() {
    console.log('--- VERSIÓN v5.4 (CARGA A PRUEBA DE FALLOS) ---'); 
    console.log('🤖 INICIANDO ROBOT...');
    robotListo = false;

    try {
        if (globalBrowser) await globalBrowser.close();

        globalBrowser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--no-zygote',
                '--window-size=1920,1080'
            ]
        });

        const pestanaLogin = await globalBrowser.newPage();
        
        // INTERCEPTOR AGRESIVO: Bloqueamos TODO lo que no sea esencial
        await pestanaLogin.setRequestInterception(true);
        pestanaLogin.on('request', (req) => {
            const resourceType = req.resourceType();
            // Bloqueamos imágenes, fuentes, media y hojas de estilo pesadas
            if (['image', 'font', 'media', 'stylesheet'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Timeout generoso de 3 minutos para el arranque total
        pestanaLogin.setDefaultNavigationTimeout(180000); 
        pestanaLogin.setDefaultTimeout(180000);
        await pestanaLogin.setViewport({ width: 1920, height: 1080 });

        console.log('   > 1. Autenticando (Intento de carga)...');
        
        // TRUCO: Usamos try/catch en el goto.
        // Si la página tarda mucho en cargar "completamente", el error salta, 
        // pero nosotros LO IGNORAMOS si el input ya existe.
        try {
            await pestanaLogin.goto('https://portal.defontana.com/login', { 
                waitUntil: 'domcontentloaded',
                timeout: 60000 // Le damos 1 minuto para cargar
            });
        } catch (e) {
            console.log('   (⚠️ Aviso: La carga total tardó, verificando si podemos escribir...)');
        }
        
        // Esperamos específicamente el input. Si esto falla, ahí sí hay problema.
        console.log('   > 1.1 Esperando casilla de correo...');
        await pestanaLogin.waitForSelector('input[formcontrolname="email"]', { timeout: 60000 });

        await pestanaLogin.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await pestanaLogin.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        console.log('   > 2. Credenciales escritas. Entrando...');
        
        // Click sin esperar navegación compleja (para evitar timeouts)
        await pestanaLogin.click('button.df-primario');

        console.log('   > 3. Esperando botón "ERP Digital"...');
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        
        // Esperamos a que aparezca el botón, ignorando si la página sigue cargando cosas de fondo
        await pestanaLogin.waitForXPath(erpButtonSelector, { visible: true, timeout: 120000 });
        const [erpButton] = await pestanaLogin.$x(erpButtonSelector);
        
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === pestanaLogin.target());
        
        await erpButton.click();
        console.log('   > 4. Abriendo pestaña ERP...');
        
        const newTarget = await newTargetPromise;
        const nuevaPestana = await newTarget.page(); 

        if (!nuevaPestana) throw new Error("No se abrió la pestaña del ERP");

        pestanaTrabajo = nuevaPestana;
        
        console.log('   > 5. Cerrando Login (Ahorro RAM)...');
        await pestanaLogin.close();

        // Configuración pestaña trabajo
        pestanaTrabajo.setDefaultNavigationTimeout(120000);
        pestanaTrabajo.setDefaultTimeout(120000);
        await pestanaTrabajo.setViewport({ width: 1920, height: 1080 });

        console.log('   > 6. Estabilizando (10s)...');
        await new Promise(r => setTimeout(r, 10000));

        console.log('   > 7. Yendo a Maestro-UX...');
        try {
            await pestanaTrabajo.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'domcontentloaded', timeout: 90000 });
        } catch(e) {
            console.log('   (⚠️ Carga lenta de Maestro-UX, intentando seguir...)');
        }

        console.log('   > 8. Esperando buscador...');
        await pestanaTrabajo.waitForSelector('input[formcontrolname="searchInputText"]', { timeout: 60000 });
        
        try {
            await pestanaTrabajo.waitForSelector('tr.mat-row', { timeout: 20000 });
            console.log('   > Tabla inicial detectada.');
        } catch(e) { console.log('   > Tabla vacía o cargando (Normal)...'); }

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO');
        robotListo = true;

    } catch (error) {
        console.error('❌ Error iniciando:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

iniciarRobot();

// --- RUTA PING ---
app.get('/ping', (req, res) => res.send('pong'));

// --- ENDPOINT CONSULTA ---
app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;
    if (!skuBuscado) return res.status(400).json({ error: 'Falta SKU' });
    
    if (!robotListo || !pestanaTrabajo) {
        iniciarRobot(); 
        return res.status(503).json({ error: 'Reiniciando sistema... espera unos segundos' });
    }

    if (robotOcupado) return res.status(429).json({ error: 'Ocupado.' });

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando Detalle: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';

        // 1. LIMPIEZA Y BÚSQUEDA
        await pestanaTrabajo.evaluate((sel) => {
            const el = document.querySelector(sel);
            if(el) el.focus();
        }, selectorInput);
        
        await pestanaTrabajo.keyboard.down('Control');
        await pestanaTrabajo.keyboard.press('A');
        await pestanaTrabajo.keyboard.up('Control');
        await pestanaTrabajo.keyboard.press('Backspace');

        await pestanaTrabajo.type(selectorInput, skuLimpio, { delay: 50 });
        await new Promise(r => setTimeout(r, 200));
        await pestanaTrabajo.keyboard.press('Enter');
        
        await new Promise(r => setTimeout(r, 4000));

        // 2. BUSCAR FILA Y CLICK EN MENÚ
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

        // 3. OPCIÓN "STOCK POR BODEGA"
        try {
            const xpathOpcion = "//span[contains(text(), 'Stock por bodega')]";
            await pestanaTrabajo.waitForXPath(xpathOpcion, { visible: true, timeout: 5000 });
            const [opcionBtn] = await pestanaTrabajo.$x(xpathOpcion);
            await opcionBtn.click();
        } catch (e) {
            throw new Error("Menú no desplegó opción");
        }

        // 4. LEER POPUP
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

        // 5. CERRAR POPUP
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

// --- LATIDO CARDÍACO ---
setInterval(async () => {
    if (robotListo && pestanaTrabajo && !robotOcupado) {
        console.log('💓 Heartbeat (48s)...');
        try {
            await pestanaTrabajo.evaluate(() => {
                window.scrollBy(0, 10);
                setTimeout(() => window.scrollBy(0, -10), 100);
            });
        } catch(e) {
            robotListo = false; 
        }
    }
}, 48000);

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});

