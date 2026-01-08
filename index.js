const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

// VARIABLES GLOBALES (Estado del Robot)
let globalBrowser = null;
let workPage = null; // La página única de trabajo
let robotListo = false;
let robotOcupado = false;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

// --- FUNCIÓN DE INICIO (Login + Salto Directo) ---
async function iniciarRobot() {
    console.log('🤖 INICIANDO ROBOT (Modo Persistente)...');
    robotListo = false;

    try {
        if (globalBrowser) await globalBrowser.close();

        // Configuración para Render (ahorro de memoria)
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

        const page = await globalBrowser.newPage();
        workPage = page;

        // Tiempos generosos
        page.setDefaultNavigationTimeout(60000);
        page.setDefaultTimeout(60000);
        await page.setViewport({ width: 1920, height: 1080 });

        // 1. LOGIN
        console.log('   > 1. Autenticando...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });
        
        await page.waitForSelector('input[formcontrolname="email"]');
  // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('   > 2. Login OK. Consolidando sesión (5s)...');
        await new Promise(r => setTimeout(r, 5000));

        // 2. SALTO DIRECTO A MAESTRO-UX
        console.log('   > 3. Saltando directo a Artículos...');
        await page.goto('https://maestro-ux.defontana.com/article', { waitUntil: 'networkidle2' });

        // 3. VERIFICACIÓN Y ESPERA
        console.log('   > 4. Esperando cuadro de búsqueda...');
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        // Esperamos a que el input exista
        await page.waitForSelector(selectorInput, { timeout: 30000 });
        
        // TRUCO EXTRA: Esperar 3 segundos más para que desaparezcan spinners/animaciones
        await new Promise(r => setTimeout(r, 3000));

        console.log('   ✅ ROBOT ESTACIONADO Y LISTO PARA BUSCAR');
        robotListo = true;

    } catch (error) {
        console.error('❌ Error iniciando robot:', error);
        robotListo = false;
        if (globalBrowser) await globalBrowser.close();
    }
}

// Arrancar al inicio
iniciarRobot();

// --- ENDPOINT DE CONSULTA ---
app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) return res.status(400).json({ error: 'Falta SKU' });
    
    // Revivir si murió
    if (!robotListo || !workPage) {
        iniciarRobot(); 
        return res.status(503).json({ error: 'Reiniciando sistema... Intenta en 1 min.' });
    }

    if (robotOcupado) {
        return res.status(429).json({ error: 'Sistema ocupado. Intenta en 2 seg.' });
    }

    robotOcupado = true;
    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`⚡ Buscando: ${skuLimpio}`);

    try {
        const selectorInput = 'input[formcontrolname="searchInputText"]';
        
        // --- AQUÍ ESTÁ LA CORRECCIÓN CLAVE ---
        // En lugar de click(), usamos focus() vía JS. Esto no falla nunca.
        await workPage.evaluate((sel) => {
            const input = document.querySelector(sel);
            if(input) input.focus(); // Obliga al navegador a entrar aquí
        }, selectorInput);

        // Pequeña pausa para asegurar que el foco entró
        await new Promise(r => setTimeout(r, 100));
        
        // Limpieza con Teclado (Ctrl + A -> Backspace)
        await workPage.keyboard.down('Control');
        await workPage.keyboard.press('A');
        await workPage.keyboard.up('Control');
        await workPage.keyboard.press('Backspace');
        
        // Escribir y Enter
        await workPage.type(selectorInput, skuLimpio, { delay: 50 });
        await new Promise(r => setTimeout(r, 100)); // Breve pausa antes de Enter
        await workPage.keyboard.press('Enter');

        // 2. Esperar Resultados
        // Esperamos brevemente a que la tabla reaccione
        try {
            await workPage.waitForSelector('.mat-column-id', { timeout: 5000 });
        } catch(e) { /* Si no sale nada es que no encontró, seguimos */ }

        // 3. Extracción de Datos
        const resultado = await workPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            const vistos = [];

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const celdaDesc = fila.querySelector('.mat-column-description');
                const celdaStock = fila.querySelector('.mat-column-stock');
                const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';
                vistos.push(textoCodigo);

                // Buscamos coincidencia (exacta o parcial)
                if (textoCodigo === sku || textoCodigo.includes(sku)) {
                    return {
                        found: true,
                        data: {
                            codigo: textoCodigo,
                            descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                            // Limpiamos espacios extra en stock y precio
                            stock: celdaStock ? celdaStock.innerText.trim() : '0',
                            precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                        }
                    };
                }
            }
            return { found: false, seen: vistos };
        }, skuLimpio);

        robotOcupado = false;
        console.log('   > Resultado:', resultado);

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
        console.error('Error en búsqueda:', error);
        robotOcupado = false;
        
        // Si el error es grave (navegador cerrado), marcamos para reinicio
        if (error.message.includes('Target closed') || error.message.includes('Session closed')) {
            robotListo = false;
        }
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    }
});

// --- MANTENER VIVO ---
setInterval(async () => {
    if (robotListo && workPage) {
        try {
            // Clic en la nada para mantener sesión activa
            await workPage.mouse.click(10, 10);
        } catch(e) { robotListo = false; }
    }
}, 300000); // 5 min

app.listen(port, () => {
    console.log(`🚀 Servidor listo en puerto ${port}`);
});
