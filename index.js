        //oz@microchip.cl 
        //@Emmet5264305!
const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// VARIABLES GLOBALES
let globalBrowser = null;
let pestanaTrabajo = null; // La pestaña del ERP
let robotListo = false;
let robotOcupado = false;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO ---
async function iniciarRobot() {
    console.log('--- VERSIÓN v4.1 (ANTI-DETACH) ---'); 
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

        // 1. PESTAÑA DE LOGIN
        const pestanaLogin = await globalBrowser.newPage();
        
        pestanaLogin.setDefaultNavigationTimeout(60000);
        pestanaLogin.setDefaultTimeout(60000);
        await pestanaLogin.setViewport({ width: 1920, height: 1080 });

        console.log('   > 1. Autenticando en Portal...');
        await pestanaLogin.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await pestanaLogin.waitForSelector('input[formcontrolname="email"]');
        await pestanaLogin.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await pestanaLogin.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            pestanaLogin.click('button.df-primario'),
            pestanaLogin.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);

        console.log('   > 2. Login OK. Buscando botón ERP...');

        // 2. CLICK Y CAPTURA
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await pestanaLogin.waitForXPath(erpButtonSelector);
        const [erpButton] = await pestanaLogin.$x(erpButtonSelector);
        
        const newTargetPromise = globalBrowser.waitForTarget(target => target.opener() === pestanaLogin.target());
        
        await erpButton.click();
        console.log('   > 3. Entrando al ERP (Validando)...');
        
        const newTarget = await newTargetPromise;
        const nuevaPestana = await newTarget.page(); 

        if (!nuevaPestana) throw new Error("No se abrió la pestaña del ERP");

        // Asignamos a global
        pestanaTrabajo = nuevaPestana;
        
        pestanaTrabajo.setDefaultNavigationTimeout(60000);
        pestanaTrabajo.setDefaultTimeout(60000);
        await pestanaTrabajo.setViewport({ width: 1920, height: 1080 });

        // --- LA CORRECCIÓN CLAVE (ANTI-DETACH) ---
        console.log('   > 4. Pestaña capturada. ESPERANDO 15s (Carga de Dashboard)...');
        // NO navegamos todavía. Dejamos que Defontana termine sus redirecciones internas.
        // Si intentamos navegar ahora, ocurre el error "Frame detached".
        await new Promise(r => setTimeout(r, 15000));

        // 3. NAVEGACIÓN AHORA SÍ
        console.log('   > 5. Dashboard estable. Yendo a Maestro-UX...');
        // Usamos domcontentloaded que es más ligero que networkidle2
        await pestanaTrabajo.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'domcontentloaded' });

        // 4. VERIFICACIÓN
        console.log('   > 6. Esperando buscador...');
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        await pestanaTrabajo.waitForSelector(selectorInput, { timeout: 40000 });
        
        // Esperamos un poco más para asegurar que la tabla cargó
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
        return res.status(503).json({ error: 'Reiniciando sistema... Espera 1 min.' });
    }

    if (robotOcupado) return res.status(429).json({ error: 'Ocupado.' });

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';

        // 1. ESCRITURA SEGURA
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

        // 2. ESPERA
        await new Promise(r => setTimeout(r, 4000));

        // 3. EXTRACCIÓN (Simplificada para asegurar JSON válido)
        const resultado = await pestanaTrabajo.evaluate((sku) => {
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
                        // Construimos el objeto plano para JSON
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
            // AQUÍ ESTÁ EL CAMBIO IMPORTANTE: Aseguramos la respuesta JSON
            res.status(200).json({ 
                status: 'ok', 
                mensaje: 'Encontrado', 
                data: resultado.data 
            });
        } else {
            res.status(200).json({ 
                status: 'ok', 
                mensaje: 'No encontrado', 
                debug: resultado.seen, // Esto se verá en el HTML
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
    if (robotListo && pestanaTrabajo) {
        try { await pestanaTrabajo.evaluate(() => document.body.click()); } catch(e) {}
    }
}, 300000);

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
