const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// Variables Globales
let globalBrowser = null;
let workPage = null; // La página del ERP donde buscaremos
let robotListo = false;
let robotOcupado = false;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO ---
async function iniciarRobot() {
    console.log('🤖 INICIANDO ROBOT (Versión Final)...');
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

        // 1. PESTAÑA DE LOGIN (Usamos variable 'page' para evitar errores)
        const page = await globalBrowser.newPage();
        
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });

        console.log('   > 1. Autenticando en Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('input[formcontrolname="email"]');
        //oz@microchip.cl 
        //@Emmet5264305!
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl '); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);

        console.log('   > 2. Login OK. Buscando botón ERP...');

        // 2. CLICK PARA OBTENER PERMISOS
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        // Preparamos la captura de la NUEVA pestaña
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === page.target());
        
        await erpButton.click();
        console.log('   > 3. Entrando al ERP (Validando)...');
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page(); // ¡Pestaña nueva capturada!

        if (!erpPage) throw new Error("No se abrió la pestaña del ERP");

        // Asignamos a la variable global
        workPage = erpPage;
        
        workPage.setDefaultNavigationTimeout(60000);
        workPage.setDefaultTimeout(60000);
        await workPage.setViewport({ width: 1920, height: 1080 });

        // Esperamos validación de token
        await new Promise(r => setTimeout(r, 8000));

        // 3. NAVEGACIÓN DIRECTA A ARTÍCULOS (En la pestaña nueva)
        console.log('   > 4. Yendo a Maestro-UX...');
        await workPage.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'networkidle2' });

        // 4. VERIFICACIÓN FINAL
        console.log('   > 5. Esperando buscador...');
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        await workPage.waitForSelector(selectorInput, { timeout: 40000 });
        
        // Espera de tabla (opcional)
        try {
            await workPage.waitForSelector('tr.mat-row', { timeout: 10000 });
            console.log('   > Tabla inicial detectada.');
        } catch(e) { console.log('   > Tabla vacía o cargando...'); }

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO');
        
        // Cerramos la pestaña de login vieja para liberar memoria
        try { await page.close(); } catch(e) {}
        
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
    
    if (!robotListo || !workPage) {
        iniciarRobot(); 
        return res.status(503).json({ error: 'Reiniciando sistema... Espera 1 min.' });
    }

    if (robotOcupado) return res.status(429).json({ error: 'Ocupado.' });

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';

        // 1. ESCRITURA SEGURA
        await workPage.evaluate((sel, texto) => {
            const input = document.querySelector(sel);
            if (!input) return;
            
            input.focus();
            input.value = texto;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
        }, selectorInput, skuLimpio);

        await new Promise(r => setTimeout(r, 200));
        await workPage.keyboard.press('Enter');

        // 2. ESPERA
        await new Promise(r => setTimeout(r, 4000));

        // 3. EXTRACCIÓN
        const resultado = await workPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            const debugInfo = []; 

            if (filas.length === 0) {
                const body = document.body.innerText;
                if (body.includes('no tiene permiso') || body.includes('Login')) {
                    return { error: 'Sesion_Caducada' };
                }
                return { found: false, count: 0 }; 
            }

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';
                
                debugInfo.push(textoCodigo);

                if (textoCodigo.includes(sku)) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock'); 
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        found: true,
                        data: {
                            codigo: textoCodigo,
                            descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                            stock: celdaStock ? celdaStock.innerText.trim() : '0',
                            precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                        }
                    };
                }
            }
            return { found: false, count: filas.length, seen: debugInfo };
        }, skuLimpio);

        robotOcupado = false;
        console.log('   > Resultado:', resultado);

        if (resultado.error === 'Sesion_Caducada') {
            robotListo = false; 
            throw new Error('La sesión caducó.');
        }

        if (resultado.found) {
            res.json({ status: 'ok', mensaje: 'Encontrado', data: resultado.data });
        } else {
            res.json({ 
                status: 'ok', 
                mensaje: 'No encontrado', 
                debug: resultado.seen, 
                data: { codigo: skuLimpio, stock: '0', precio: '-' } 
            });
        }

    } catch (error) {
        console.error('Error búsqueda:', error);
        robotOcupado = false;
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            robotListo = false;
        }
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    }
});

// Ping
setInterval(async () => {
    if (robotListo && workPage) {
        try { await workPage.evaluate(() => document.body.click()); } catch(e) {}
    }
}, 300000);

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
