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

// --- FUNCIÓN DE INICIO ROBUSTA ---
async function iniciarRobot() {
    console.log('--- VERSIÓN v5.3 (PACIENCIA DE ACERO) ---'); 
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
        
        // INTERCEPTOR DE PETICIONES (Ahorra memoria y datos)
        await pestanaLogin.setRequestInterception(true);
        pestanaLogin.on('request', (req) => {
            if (['image', 'font', 'media'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // AUMENTAMOS TIMEOUT A 120 SEGUNDOS (Vital para Render Free)
        pestanaLogin.setDefaultNavigationTimeout(120000); 
        pestanaLogin.setDefaultTimeout(120000);
        await pestanaLogin.setViewport({ width: 1920, height: 1080 });

        console.log('   > 1. Autenticando...');
        // Usamos wait until networkidle2 solo aquí para asegurar carga del form
        try {
            await pestanaLogin.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        } catch (e) {
            console.log('   (Nota: El goto inicial tardó, pero seguimos...)');
        }
        
        await pestanaLogin.waitForSelector('input[formcontrolname="email"]');
        await pestanaLogin.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await pestanaLogin.type('input[formcontrolname="password"]', '@Emmet53279!'); 
        
        // ESTRATEGIA NUEVA: NO ESPERAR NAVEGACIÓN, ESPERAR EL RESULTADO
        console.log('   > 2. Enviando credenciales...');
        await pestanaLogin.click('button.df-primario');

        // En lugar de waitForNavigation (que falla), esperamos que aparezca el botón del éxito
        console.log('   > 3. Esperando botón "ERP Digital" (Hasta 120s)...');
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        
        try {
            await pestanaLogin.waitForXPath(erpButtonSelector, { timeout: 120000, visible: true });
        } catch (error) {
            throw new Error("Timeout esperando entrar. Posible clave incorrecta o Defontana caído.");
        }
        
        const [erpButton] = await pestanaLogin.$x(erpButtonSelector);
        
        // Preparamos captura de pestaña nueva
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === pestanaLogin.target());
        
        await erpButton.click();
        console.log('   > 4. Abriendo pestaña ERP...');
        
        const newTarget = await newTargetPromise;
        const nuevaPestana = await newTarget.page(); 

        if (!nuevaPestana) throw new Error("No se abrió la pestaña del ERP");

        // --- CAMBIO DE PESTAÑA ---
        pestanaTrabajo = nuevaPestana;
        
        console.log('   > 5. Liberando memoria (Cerrando Login)...');
        await pestanaLogin.close(); // Cerramos la vieja

        // Configuración de la nueva pestaña de trabajo
        pestanaTrabajo.setDefaultNavigationTimeout(120000);
        pestanaTrabajo.setDefaultTimeout(120000);
        await pestanaTrabajo.setViewport({ width: 1920, height: 1080 });

        console.log('   > 6. Estabilizando Dashboard (10s)...');
        await new Promise(r => setTimeout(r, 10000));

        console.log('   > 7. Yendo a Maestro-UX...');
        // Usamos domcontentloaded, es más rápido y menos propenso a timeout
        await pestanaTrabajo.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'domcontentloaded' });

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

