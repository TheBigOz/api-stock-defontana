
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

        await Promise.all([
            page.click('button.df-primario'),
            page.waitForNavigation({ waitUntil: 'domcontentloaded' })
        ]);
        
        console.log('2. Login OK. Abriendo ERP...');

        // 2. ABRIR PESTAÑA ERP
        const erpButtonSelector = "//h3[contains(text(), 'ERP Digital')]";
        await page.waitForXPath(erpButtonSelector);
        const [erpButton] = await page.$x(erpButtonSelector);
        
        const newTargetPromise = browser.waitForTarget(target => target.opener() === page.target());
        await erpButton.click();
        
        const newTarget = await newTargetPromise;
        const erpPage = await newTarget.page();
        
        if (!erpPage) throw new Error("No se pudo capturar la pestaña del ERP");

        erpPage.setDefaultNavigationTimeout(60000);
        erpPage.setDefaultTimeout(60000);
        await erpPage.setViewport({ width: 1920, height: 1080 });

        // 3. ESTABILIZACIÓN (La clave del éxito)
        console.log('3. Pestaña detectada. ESPERANDO 15 SEGUNDOS...');
        await new Promise(r => setTimeout(r, 15000));

        // 4. NAVEGACIÓN POR MENÚ (Clics)
        console.log('4. Tiempo cumplido. Buscando menú Inventario...');
        
        // Buscamos el botón Inventario
        const xpathInventario = "//span[contains(text(), 'Inventario')]";
        try {
            await erpPage.waitForXPath(xpathInventario, { visible: true, timeout: 10000 });
            const [btnInventario] = await erpPage.$x(xpathInventario);
            await erpPage.evaluate(el => el.click(), btnInventario); // Clic JS
            console.log('   > Clic en Inventario OK');
        } catch (e) {
            console.log('   > Error buscando botón Inventario (¿Ya estaba abierto o URL cambió?)');
        }

        await new Promise(r => setTimeout(r, 1000));

        // Buscamos el botón Artículos
        console.log('5. Buscando submenú Artículos...');
        const xpathArticulos = "//span[contains(text(), 'Artículos')]";
        await erpPage.waitForXPath(xpathArticulos, { visible: true });
        const [btnArticulos] = await erpPage.$x(xpathArticulos);
        await erpPage.evaluate(el => el.click(), btnArticulos); // Clic JS

        console.log('6. Esperando carga del módulo (5 seg)...');
        await new Promise(r => setTimeout(r, 5000));

        // 5. BÚSQUEDA DEL INPUT (ESCANER MULTI-FRAME)
        console.log('7. Buscando el INPUT (Escaneando frames)...');
        
        let targetFrame = erpPage;
        // Selectores posibles (Probamos varios por seguridad)
        const searchSelectors = [
            'input[formcontrolname="searchInputText"]',
            'input[placeholder*="descripción"]', 
            'input[placeholder*="Articulo"]'
        ];
        
        let foundSelector = null;

        // Función auxiliar para buscar en un frame
        async function findSelectorInFrame(frame) {
            for (const sel of searchSelectors) {
                if (await frame.$(sel) !== null) return sel;
            }
            return null;
        }

        // A) Buscar en Principal
        foundSelector = await findSelectorInFrame(erpPage);

        // B) Buscar en Iframes (si no está en principal)
        if (!foundSelector) {
            for (const frame of erpPage.frames()) {
                const s = await findSelectorInFrame(frame);
                if (s) {
                    targetFrame = frame;
                    foundSelector = s;
                    console.log(`   > ¡Encontrado en un Iframe!`);
                    break;
                }
            }
        }

        if (!foundSelector) {
            const urlFinal = erpPage.url();
            throw new Error(`No se encontró el input de búsqueda. URL final: ${urlFinal}`);
        }

        console.log(`8. Input detectado (${foundSelector}). Escribiendo...`);
        
        // Escribir en el frame correcto
        await targetFrame.evaluate((sel) => { document.querySelector(sel).value = ""; }, foundSelector);
        await targetFrame.type(foundSelector, skuLimpio);
        await targetFrame.keyboard.press('Enter');

        // 6. RESULTADOS
        console.log('9. Esperando resultados...');
        try {
            await targetFrame.waitForSelector('.mat-column-id', { timeout: 15000 });
        } catch (e) {
            console.log('...Tabla lenta o vacía...');
        }

        const resultado = await targetFrame.evaluate((sku) => {
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
