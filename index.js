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

// --- FUNCIÓN DE INICIO (Idéntica a la anterior) ---
async function iniciarRobot() {
    console.log('--- VERSIÓN v5.0 (AUDITOR DE BODEGAS) ---'); 
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
        pestanaLogin.setDefaultNavigationTimeout(60000);
        pestanaLogin.setDefaultTimeout(60000);
        await pestanaLogin.setViewport({ width: 1920, height: 1080 });

        console.log('   > 1. Autenticando...');
        await pestanaLogin.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await pestanaLogin.waitForSelector('input[formcontrolname="email"]');
        await pestanaLogin.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await pestanaLogin.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            pestanaLogin.click('button.df-primario'),
            pestanaLogin.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);

        console.log('   > 2. Login OK. Buscando botón ERP...');

        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await pestanaLogin.waitForXPath(erpButtonSelector);
        const [erpButton] = await pestanaLogin.$x(erpButtonSelector);
        
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === pestanaLogin.target());
        
        await erpButton.click();
        console.log('   > 3. Entrando al ERP...');
        
        const newTarget = await newTargetPromise;
        const nuevaPestana = await newTarget.page(); 

        if (!nuevaPestana) throw new Error("No se abrió la pestaña del ERP");

        pestanaTrabajo = nuevaPestana;
        pestanaTrabajo.setDefaultNavigationTimeout(60000);
        pestanaTrabajo.setDefaultTimeout(60000);
        await pestanaTrabajo.setViewport({ width: 1920, height: 1080 });

        console.log('   > 4. Esperando 15s (Estabilidad)...');
        await new Promise(r => setTimeout(r, 15000));

        console.log('   > 5. Yendo a Maestro-UX...');
        await pestanaTrabajo.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'domcontentloaded' });

        console.log('   > 6. Esperando buscador...');
        await pestanaTrabajo.waitForSelector('input[formcontrolname="searchInputText"]', { timeout: 40000 });
        
        try {
            await pestanaTrabajo.waitForSelector('tr.mat-row', { timeout: 15000 });
            console.log('   > Tabla inicial detectada.');
        } catch(e) { console.log('   > Tabla vacía o cargando...'); }

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO');
        try { await pestanaLogin.close(); } catch(e) {}
        robotListo = true;

    } catch (error) {
        console.error('❌ Error iniciando:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

iniciarRobot();

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

        // 1. LIMPIEZA Y BÚSQUEDA
        await pestanaTrabajo.evaluate((sel, texto) => {
            const input = document.querySelector(sel);
            if (!input) return;
            input.focus();
            input.value = texto;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, selectorInput, skuLimpio);

        await new Promise(r => setTimeout(r, 200));
        await pestanaTrabajo.keyboard.press('Enter');
        await new Promise(r => setTimeout(r, 3500)); // Esperar grilla

        // 2. ENCONTRAR FILA Y ABRIR POPUP
        // Aquí ocurre la magia: Buscamos la fila correcta y hacemos clic en los 3 puntos
        const datosGenerales = await pestanaTrabajo.evaluate(async (sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    // Encontramos la fila. Extraemos datos básicos primero.
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');
                    
                    // Ahora buscamos el botón de menú (los 3 puntos)
                    const botonMenu = fila.querySelector('.mat-menu-trigger');
                    if (botonMenu) {
                        botonMenu.click(); // CLIC FÍSICO AL MENÚ
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

        // 3. SELECCIONAR "STOCK POR BODEGA" DEL MENÚ FLOTANTE
        console.log('   > Menú abierto. Buscando opción "Stock por bodega"...');
        // Esperamos a que aparezca el menú flotante
        try {
            const xpathOpcion = "//span[contains(text(), 'Stock por bodega')]";
            await pestanaTrabajo.waitForXPath(xpathOpcion, { visible: true, timeout: 5000 });
            const [opcionBtn] = await pestanaTrabajo.$x(xpathOpcion);
            await opcionBtn.click();
        } catch (e) {
            throw new Error("No se pudo hacer clic en Stock por Bodega");
        }

        // 4. LEER LA VENTANA EMERGENTE (POPUP)
        console.log('   > Popup abierto. Leyendo bodegas...');
        // Esperamos que cargue la tabla del popup
        await pestanaTrabajo.waitForSelector('.stock-article-storage-dialog', { timeout: 10000 });
        await new Promise(r => setTimeout(r, 1000)); // Estabilidad

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
                    
                    // Convertir "Sin Stock" a 0
                    let stockNum = (stockTexto === 'Sin Stock') ? 0 : parseInt(stockTexto, 10);
                    if (isNaN(stockNum)) stockNum = 0;

                    if (nombre.includes('Bodega_Central_962')) {
                        central = stockNum;
                    } else if (nombre.includes('Sala_Ventas_962')) {
                        ventas = stockNum;
                    }
                }
            });
            return { central, ventas };
        });

        // 5. CERRAR EL POPUP (MUY IMPORTANTE)
        console.log('   > Cerrando popup...');
        await pestanaTrabajo.keyboard.press('Escape');
        await new Promise(r => setTimeout(r, 500)); // Esperar cierre

        robotOcupado = false;
        
        // Calculamos el total nosotros mismos para que sea real
        const stockTotalCalculado = bodegas.central + bodegas.ventas;

        const respuestaFinal = {
            codigo: skuLimpio,
            descripcion: datosGenerales.desc,
            precio: datosGenerales.precio,
            stockCentral: bodegas.central,
            stockVentas: bodegas.ventas,
            stockTotal: stockTotalCalculado
        };

        console.log('   > Datos finales:', respuestaFinal);

        res.json({ 
            status: 'ok', 
            mensaje: 'Encontrado', 
            data: respuestaFinal 
        });

    } catch (error) {
        console.error('Error búsqueda:', error);
        robotOcupado = false;
        // Intento de emergencia de cerrar popup si falló algo
        try { await pestanaTrabajo.keyboard.press('Escape'); } catch(e) {}
        
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            robotListo = false;
        }
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    }
});

// Ping
setInterval(async () => {
    if (robotListo && pestanaTrabajo) {
        try { await pestanaTrabajo.evaluate(() => document.body.click()); } catch(e) {}
    }
}, 300000);

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
