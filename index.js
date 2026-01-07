const express = require('express');
const puppeteer = require('puppeteer');
const app = express();
const port = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    next();
});

app.get('/consultar', async (req, res) => {
    const skuBuscado = req.query.sku;

    if (!skuBuscado) {
        return res.status(400).json({ error: 'Falta el parámetro SKU' });
    }

    const skuLimpio = skuBuscado.trim().toUpperCase();
    console.log(`--- Iniciando búsqueda para: ${skuLimpio} ---`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--single-process',
                '--window-size=1920,1080'
            ]
        });

        const page = await browser.newPage();
        
        // Timeout muy generoso
        page.setDefaultNavigationTimeout(60000); 
        page.setDefaultTimeout(60000);

        await page.setViewport({ width: 1920, height: 1080 });
        
        // 1. LOGIN
        console.log('1. Entrando al Portal...');
        await page.goto('https://portal.defontana.com/login', { waitUntil: 'domcontentloaded' });

        await page.waitForSelector('input[formcontrolname="email"]');
        
        // CREDENCIALES
        await page.type('input[formcontrolname="email"]', 'oz@microchip.cl'); 
        await page.type('input[formcontrolname="password"]', '@Emmet5264305!'); 

        console.log('2. Enviando credenciales...');
        
        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('3. Login OK. Buscando enlace ERP...');

        // 2. ABRIR NUEVA PESTAÑA
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        
        await erpButton.click();
        console.log('4. Click en ERP Digital. Esperando pestaña...');
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        if (!erpPage) throw new Error("No se pudo capturar la pestaña del ERP");

        // Configuración pestaña nueva
        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        console.log('5. Pestaña detectada. Esperando carga TOTAL del Dashboard...');
        
        // --- CAMBIO CLAVE 1: Esperar a que el menú exista ---
        // Esto confirma que Defontana terminó de hacer sus redirecciones locas.
        // Buscamos cualquier elemento del menú lateral (ej: clase .menu-title)
        try {
            await erpPage.waitForSelector('.menu-title', { timeout: 20000 });
        } catch (e) {
            console.log('Advertencia: El menú tardó en aparecer, intentando continuar igual...');
        }

        // --- CAMBIO CLAVE 2: Navegación por JS (No por goto) ---
        console.log('6. Dashboard listo. Inyectando navegación a Artículos...');
        
        const urlInventario = 'https://erp.defontana.com/#/Inventario/Inventario/Articulos';
        
        // En lugar de "erpPage.goto" (que rompe el frame), usamos javascript puro
        // para cambiar la URL desde adentro.
        await erpPage.evaluate((url) => {
            window.location.href = url;
        }, urlInventario);

        console.log('7. Navegación inyectada. Esperando input de búsqueda...');

        // 3. BÚSQUEDA
        const searchInputSelector = 'input[formcontrolname="searchInputText"]';
        
        // Esperamos que el cambio de URL surta efecto y aparezca el input
        await erpPage.waitForSelector(searchInputSelector);
        
        // Limpiamos y escribimos
        await erpPage.evaluate((sel) => document.querySelector(sel).value = "", searchInputSelector);
        await erpPage.type(searchInputSelector, skuLimpio);
        await erpPage.keyboard.press('Enter');

        console.log(`8. Buscando SKU: ${skuLimpio}`);

        // 4. RESULTADOS
        try {
            await erpPage.waitForSelector('.mat-column-id', { timeout: 10000 });
        } catch (e) {
            console.log('...Tabla lenta o vacía...');
        }

        const resultado = await erpPage.evaluate((sku) => {
            const filas = document.querySelectorAll('tr.mat-row');
            if (filas.length === 0) return null;

            for (let fila of filas) {
                const celdaCodigo = fila.querySelector('.mat-column-id');
                const textoCodigo = celdaCodigo ? celdaCodigo.innerText.trim() : '';

                if (textoCodigo === sku) {
                    const celdaDesc = fila.querySelector('.mat-column-description');
                    const celdaStock = fila.querySelector('.mat-column-stock');
                    const celdaPrecio = fila.querySelector('.mat-column-salePrice');

                    return {
                        codigo: textoCodigo,
                        descripcion: celdaDesc ? celdaDesc.innerText.trim() : 'Sin descripción',
                        stock: celdaStock ? celdaStock.innerText.trim() : '0',
                        precio: celdaPrecio ? celdaPrecio.innerText.trim() : '0'
                    };
                }
            }
            return null;
        }, skuLimpio);

        if (resultado) {
            res.json({ status: 'ok', mensaje: 'Producto encontrado', data: resultado });
        } else {
            res.json({
                status: 'ok',
                mensaje: 'Agotado o No encontrado',
                data: { codigo: skuLimpio, stock: '0', precio: '-' }
            });
        }

    } catch (error) {
        console.error('ERROR FATAL:', error);
        res.status(500).json({ error: 'Error interno', detalle: error.message });
    } finally {
        if (browser) await browser.close();
    }
});

app.listen(port, () => {
    console.log(`Servidor listo en puerto ${port}`);
});
