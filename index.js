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

// --- FUNCIÓN DE INICIO: EL RELEVO ÚNICO ---
async function iniciarRobot() {
    console.log('--- VERSIÓN v5.8 (RELEVO ÚNICO DE MEMORIA) ---'); 
    console.log('🤖 INICIANDO ROBOT...');
    robotListo = false;

    try {
        if (globalBrowser) await globalBrowser.close();

        // LANZAMIENTO AUSTERO
        globalBrowser = await puppeteer.launch({
            headless: "new",
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Vital para Docker/Render
                '--single-process', // Ahorro crítico de RAM
                '--no-zygote',
                '--disable-gpu',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--mute-audio',
                '--no-first-run',
                '--window-size=1280,720'
            ]
        });

        // TRUCO DE ORO: No creamos pestaña nueva. Usamos la que viene por defecto.
        // Así evitamos tener 2 pestañas (la blank y la login) al inicio.
        const pages = await globalBrowser.pages();
        const paginaActual = pages[0]; // Usamos esta para el Login

        // INTERCEPTOR AGRESIVO
        await paginaActual.setRequestInterception(true);
        paginaActual.on('request', (req) => {
            const rType = req.resourceType();
            // Bloqueamos absolutamente todo lo visual
            if (['image', 'font', 'media', 'stylesheet', 'other'].includes(rType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        paginaActual.setDefaultNavigationTimeout(180000); 
        await paginaActual.setViewport({ width: 1280, height: 720 });

        console.log('   > 1. Autenticando...');
        
        try {
            await paginaActual.goto('https://portal.defontana.com/login', { 
                waitUntil: 'domcontentloaded', 
                timeout: 60000 
            });
        } catch (e) { console.log('   (Carga lenta, seguimos...)'); }

        await paginaActual.waitForSelector('input[formcontrolname="email"]', { timeout: 60000 });
        //oz@microchip.cl 
        //@Emmet53279!
        await paginaActual.type('input[formcontrolname="email"]', 'oz@microchip.cl '); 
        await paginaActual.type('input[formcontrolname="password"]', '@Emmet53279!'); 
        
        console.log('   > 2. Login...');
        await paginaActual.click('button.df-primario');

        console.log('   > 3. Esperando botón ERP...');
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        try {
            await paginaActual.waitForXPath(erpButtonSelector, { visible: true, timeout: 120000 });
        } catch (error) {
            throw new Error("Memoria insuficiente para cargar el menú de empresas.");
        }
        
        const [erpButton] = await paginaActual.$x(erpButtonSelector);
        
        // --- LA MANIOBRA DE RIESGO (EL RELEVO) ---
        console.log('   > 4. INICIANDO RELEVO DE PESTAÑA...');
        
        // 1. Preparamos la escucha
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === paginaActual.target());
        
        // 2. Hacemos clic
        await erpButton.click();
        
        // 3. Detectamos que se creó el "Target" (pero aún no cargamos la página)
        const newTarget = await newTargetPromise;
        
        // 4. ¡MATAMOS LA PESTAÑA VIEJA ANTES DE CARGAR LA NUEVA!
        // Esto libera los 100-200MB del Login para dárselos al ERP.
        console.log('   > 5. Cerrando Login (Liberando RAM)...');
        await paginaActual.close(); 
        
        // 5. Ahora sí, nos conectamos a la nueva pestaña
        console.log('   > 6. Conectando a nueva pestaña...');
        pestanaTrabajo = await newTarget.page();

        if (!pestanaTrabajo) throw new Error("Falló el relevo de pestaña.");

        // 6. Blindamos la nueva pestaña inmediatamente
        await pestanaTrabajo.setRequestInterception(true);
        pestanaTrabajo.on('request', (req) => {
            if (['image', 'font', 'media', 'stylesheet', 'other'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        pestanaTrabajo.setDefaultNavigationTimeout(120000);
        await pestanaTrabajo.setViewport({ width: 1280, height: 720 });

        console.log('   > 7. Marcando presencia en HOME (10s)...');
        // Dejamos que cargue lo mínimo para validar el token
        await new Promise(r => setTimeout(r, 10000));

        console.log('   > 8. Yendo a Maestro-UX...');
        await pestanaTrabajo.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'domcontentloaded' });

        console.log('   > 9. Esperando buscador...');
        await pestanaTrabajo.waitForSelector('input[formcontrolname="searchInputText"]', { timeout: 60000 });
        
        try {
            await pestanaTrabajo.waitForSelector('tr.mat-row', { timeout: 20000 });
            console.log('   > Tabla inicial detectada.');
        } catch(e) { console.log('   > Tabla vacía (Normal).'); }

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO');
        robotListo = true;

    } catch (error) {
        console.error('❌ Error iniciando:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

iniciarRobot();

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

        // 1. Limpieza
        await pestanaTrabajo.evaluate((sel) => {
            const el = document.querySelector(sel);
            if(el) el.focus();
            el.value = '';
        }, selectorInput);
        
        await pestanaTrabajo.type(selectorInput, skuLimpio, { delay: 50 });
        await new Promise(r => setTimeout(r, 200));
        await pestanaTrabajo.keyboard.press('Enter');
        
        await new Promise(r => setTimeout(r, 4000));

        // 2. Buscar fila
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
